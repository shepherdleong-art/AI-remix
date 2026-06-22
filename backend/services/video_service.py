"""
Video processing service.

- Scene detection & frame extraction using ffmpeg
- Compositing (video + audio → final output)
"""
import os
import logging
import subprocess
import tempfile
from pathlib import Path
from typing import Optional

from config import (
    FFMPEG_EXECUTABLE,
    TEMP_DIR,
    AI_SCENE_THRESHOLD,
    AI_MIN_SCENE_DURATION,
)

logger = logging.getLogger(__name__)


def _ffmpeg() -> str:
    return FFMPEG_EXECUTABLE if os.path.exists(FFMPEG_EXECUTABLE) else "ffmpeg"


def detect_scenes(
    video_path: str,
    threshold: float | None = None,
    min_duration: float | None = None,
) -> list[dict]:
    """
    Detect scene changes in a video using ffmpeg's scene detection filter.

    Returns list of scenes: [{start, end, duration}, ...]
    """
    if not os.path.exists(video_path):
        raise FileNotFoundError(f"Video not found: {video_path}")

    if threshold is None:
        threshold = AI_SCENE_THRESHOLD
    if min_duration is None:
        min_duration = AI_MIN_SCENE_DURATION

    # Get video duration using ffmpeg (not ffprobe, for reliability)
    dur_cmd = [
        _ffmpeg(), "-i", video_path, "-f", "null", "-"
    ]
    dur_result = subprocess.run(dur_cmd, capture_output=True, text=True, timeout=30)
    if dur_result.returncode != 0:
        raise RuntimeError(
            f"Failed to probe video duration: {video_path}\n"
            f"stderr: {dur_result.stderr[:300]}"
        )
    duration_line = dur_result.stderr
    total_duration = 0.0
    for line in duration_line.split("\n"):
        if "Duration:" in line:
            # Format: Duration: 00:00:05.23, start: ...
            time_str = line.split("Duration:")[1].split(",")[0].strip()
            parts = time_str.split(":")
            total_duration = float(parts[0]) * 3600 + float(parts[1]) * 60 + float(parts[2])
            break

    if total_duration <= 0:
        raise RuntimeError(f"Could not determine video duration: {video_path}")

    # Use ffmpeg scene detection
    cmd = [
        _ffmpeg(), "-i", video_path,
        "-vf", f"select='gt(scene,{threshold/100})',metadata=print:file=-",
        "-f", "null", "-"
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if result.returncode != 0:
        raise RuntimeError(
            f"Scene detection failed for: {video_path}\n"
            f"stderr: {result.stderr[:300]}"
        )

    # Parse scene change timestamps from stderr
    scene_times = [0.0]
    for line in result.stderr.split("\n"):
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
        "-y",
        output_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
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
            "-ss", str(start_time),
            "-i", video_path,
            "-t", str(duration),
            "-vf", f"scale={target_width}:{target_height}:force_original_aspect_ratio=increase,"
                   f"crop={target_width}:{target_height},setsar=1",
            "-c:v", "libx264",
            "-preset", "ultrafast",
            "-crf", "23",
            "-pix_fmt", "yuv420p",
            "-an",
            "-y", trimmed,
        ], capture_output=True, text=True, timeout=60)

        if result.returncode != 0:
            logger.warning(f"Trim failed for segment {i}: {result.stderr[:200]}")
            continue

        trimmed_files.append(trimmed)

    if not trimmed_files:
        raise RuntimeError("No valid video segments after trimming")

    # Create concat file
    concat_file = os.path.join(os.path.dirname(output_path), "concat.txt")
    with open(concat_file, "w") as f:
        for tf in trimmed_files:
            f.write(f"file '{tf}'\n")

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
    ], capture_output=True, text=True, timeout=120)

    if result.returncode != 0:
        raise RuntimeError(f"Concat failed: {result.stderr[:300]}")

    # Mix with audio
    mixed_video = output_path + ".mixed.mp4"
    if os.path.exists(audio_path) and os.path.getsize(audio_path) > 0:
        result = subprocess.run([
            _ffmpeg(),
            "-i", temp_video,
            "-i", audio_path,
            "-c:v", "copy",
            "-c:a", "aac",
            "-b:a", "128k",
            "-shortest",
            "-y", mixed_video,
        ], capture_output=True, text=True, timeout=60)
        if result.returncode != 0:
            raise RuntimeError(f"Audio mix failed: {result.stderr[:300]}")
    else:
        os.rename(temp_video, mixed_video)

    # Subtitle rendering via SRT
    if subtitle_style:
        _render_subtitles(mixed_video, segments, subtitle_style, output_path, target_width, target_height)
        try: os.unlink(mixed_video)
        except OSError: pass
    else:
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
    """Burn subtitles using SRT file + ffmpeg subtitles filter (reliable)."""
    font_name = style.get("font", "Microsoft YaHei")
    font_size = int(style.get("size", 24))
    font_color = style.get("color", "white")
    stroke_color = style.get("stroke_color", "black")
    stroke_width = int(style.get("stroke_width", 2))
    # Build font path — escape for ffmpeg
    font_path = style.get("font_path", "")
    if font_path and os.path.exists(font_path):
        escaped_font = font_path.replace(":", "\\:")
    else:
        for c in [f"C\\:/Windows/Fonts/simhei.ttf", f"C\\:/Windows/Fonts/msyh.ttc"]:
            if os.path.exists(c.replace("\\:", ":")):
                escaped_font = c
                break
        else:
            escaped_font = "C\\:/Windows/Fonts/simhei.ttf"

    # Generate SRT file
    srt_path = os.path.join(os.path.dirname(output_path), "subs.srt")
    acc = 0.0
    lines = []
    for i, seg in enumerate(segments):
        text = (seg.get("segment_text") or "").strip()
        dur = seg.get("duration", 2.0)
        if not text:
            acc += dur
            continue
        # Write subtitle segment
        start = acc
        end = acc + dur
        lines.append(f"{i + 1}")
        lines.append(f"{_fmt_srt(start)} --> {_fmt_srt(end)}")
        lines.append(text)
        lines.append("")
        acc += dur

    if not lines:
        import shutil; shutil.copy2(video_path, output_path); return

    srt_content = "\n".join(lines)
    with open(srt_path, "w", encoding="utf-8") as f:
        f.write(srt_content)

    logger.info(f"Generated SRT: {len(lines)//4} subtitles, font={font_name}")

    # Use ffmpeg subtitles filter with ASS force_style
    force = f"FontName={font_name},FontSize={font_size},PrimaryColour=&H{_bgr(font_color)},OutlineColour=&H{_bgr(stroke_color)},Outline={stroke_width},Alignment=2"
    # Escape path: backslash→slash first, then colon→\:  
    srt_escaped = srt_path.replace("\\", "/").replace(":", "\\:")
    cmd = [
        _ffmpeg(),
        "-i", video_path,
        "-vf", f"subtitles='{srt_escaped}':force_style='{force}'",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
        "-c:a", "copy", "-y", output_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if result.returncode != 0:
        logger.warning(f"Subtitle burn failed: {result.stderr[-300:]}")
        import shutil; shutil.copy2(video_path, output_path)
    else:
        logger.info(f"Subtitle burn OK, output: {os.path.getsize(output_path)} bytes")
        try: os.unlink(srt_path)
        except OSError: pass


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
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
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
