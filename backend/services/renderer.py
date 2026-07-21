"""
FFmpeg-based video rendering engine.

Provides:
- RenderEngine: async video rendering using FFmpeg subprocess
- FFmpegCommandBuilder: translates Template + Segments → FFmpeg filter chains
- RenderQueue: in-memory job queue with JSON persistence

All rendering is async via asyncio.create_subprocess_exec.
Progress is parsed from FFmpeg stderr output.
"""

import asyncio
import json
import os
import platform
import shutil
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Callable, Dict, List, Any

from config import (
    BASE_DIR,
    TEMP_DIR,
    RENDER_DEFAULTS,
    FFMPEG_EXECUTABLE,
    ErrorCode,
)


# ─── Paths ────────────────────────────────────────────────────

OUTPUT_DIR: Path = BASE_DIR / "data" / "output"
RENDERS_DIR: Path = BASE_DIR / "data" / "renders"

OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
RENDERS_DIR.mkdir(parents=True, exist_ok=True)

# ─── Transition to xfade mapping ──────────────────────────────

TRANSITION_XFADE_MAP: Dict[str, str] = {
    "none": "",
    "fade": "fade",
    "slide": "wipeleft",
    "zoom": "zoomin",
    "wipe": "wiperight",
    "dissolve": "fadeblack",
}

# ─── Render timeout (30 minutes) ──────────────────────────────

RENDER_TIMEOUT_SEC: int = 30 * 60


# ─── FFmpeg availability check ────────────────────────────────

def check_ffmpeg_available() -> bool:
    """Check if FFmpeg is available on the system PATH or at the bundled path."""
    # Try bundled path first
    ffmpeg_path: str = FFMPEG_EXECUTABLE
    if os.path.isfile(ffmpeg_path):
        return True
    # Try system PATH
    return shutil.which("ffmpeg") is not None


def get_ffmpeg_path() -> str:
    """Get the FFmpeg executable path."""
    ffmpeg_path: str = FFMPEG_EXECUTABLE
    if os.path.isfile(ffmpeg_path):
        return ffmpeg_path
    system_path: Optional[str] = shutil.which("ffmpeg")
    if system_path:
        return system_path
    raise FileNotFoundError(
        "FFmpeg not found. Please install FFmpeg and ensure it is available on the system PATH "
        "or place it in the resources/ffmpeg directory."
    )


# ─── FFmpeg Command Builder ───────────────────────────────────

class FFmpegCommandBuilder:
    """
    Builds FFmpeg command-line arguments from a template and its segments.

    Supports:
    - Segment trimming (trim filter)
    - Speed adjustment (setpts filter)
    - Visual filters (eq, contrast, saturation)
    - Text overlay (drawtext filter)
    - Cross-fade transitions (xfade filter)
    - Volume adjustment
    - Output format/resolution/fps/codec control
    - GIF output with palettegen/paletteuse

    Strategy:
    1. Build per-segment filter chains (trim + speed + color + text)
    2. If no transitions: use simple concat demuxer
    3. If transitions: build complex xfade filtergraph
    """

    def __init__(
        self,
        template: Dict[str, Any],
        materials: List[Dict[str, Any]],
        config: Dict[str, Any],
    ):
        self.template: Dict[str, Any] = template
        self.materials: List[Dict[str, Any]] = materials
        self.config: Dict[str, Any] = config
        self.segments: List[Dict[str, Any]] = template.get("segments", [])
        self._material_map: Dict[str, str] = self._build_material_map()

    def _build_material_map(self) -> Dict[str, str]:
        """Build a map from material ID to file path."""
        result: Dict[str, str] = {}
        for mat in self.materials:
            mat_id: str = mat.get("id", "")
            file_path: str = mat.get("file_path", mat.get("filePath", ""))
            if mat_id and file_path:
                result[mat_id] = file_path
        return result

    def _get_material_path(self, material_id: str) -> str:
        """Get the file path for a material ID, or raise an error."""
        path: Optional[str] = self._material_map.get(material_id)
        if not path:
            raise ValueError(f"Material not found for ID: {material_id}")
        if not os.path.isfile(path):
            raise FileNotFoundError(f"Material file not found: {path}")
        return path

    def _escape_path(self, path: str) -> str:
        """Escape a file path for FFmpeg command line (wrap in quotes)."""
        # Use single quotes on Unix, double on Windows, but FFmpeg handles both
        return f'"{path}"'

    def build(self) -> List[str]:
        """
        Build the complete FFmpeg command.

        Uses filter_complex with trim+concat for all rendering.
        For GIF output, adds palettegen/paletteuse.
        For transitions, uses xfade between segments.

        Returns:
            List of command arguments for asyncio.create_subprocess_exec.
        """
        ffmpeg_path: str = get_ffmpeg_path()
        cmd: List[str] = [ffmpeg_path, "-y"]

        segments: List[Dict[str, Any]] = self.segments
        if not segments:
            raise ValueError("Template has no segments to render")

        output_format: str = self.config.get("output_format", "mp4")
        has_transitions: bool = any(
            s.get("transition_out", {}).get("type", "none") != "none"
            for s in segments[:-1]
        )
        has_filters: bool = any(
            s.get("filters") or s.get("text_overlay") or s.get("textOverlay")
            or float(s.get("speed", 1.0)) != 1.0
            for s in segments
        )

        if output_format == "gif":
            return self._build_gif_command(cmd)
        elif has_transitions:
            return self._build_xfade_command(cmd)
        elif has_filters:
            return self._build_filter_complex_concat(cmd)
        else:
            return self._build_simple_concat(cmd)

    def _build_simple_concat(self, cmd: List[str]) -> List[str]:
        """
        Build command using concat demuxer with inpoint/outpoint.
        Fastest path: no per-segment filters, no transitions.
        """
        output_path: str = self._get_output_path()
        resolution: Dict[str, int] = self._get_resolution()
        fps: int = self.config.get("fps", 30)
        include_audio: bool = self.config.get("include_audio", True)

        # Build concat file list with inpoint/outpoint
        concat_file: Path = TEMP_DIR / f"concat_{uuid.uuid4().hex[:8]}.txt"

        with open(concat_file, "w", encoding="utf-8") as f:
            for seg in self.segments:
                material_path: str = self._get_material_path(
                    seg.get("material_id", seg.get("materialId", ""))
                )
                start: float = float(seg.get("start_time", seg.get("startTime", 0)))
                end: float = float(seg.get("end_time", seg.get("endTime", start + 3)))
                f.write(f"file '{material_path}'\n")
                f.write(f"inpoint {start}\n")
                f.write(f"outpoint {end}\n")

        cmd.extend([
            "-f", "concat",
            "-safe", "0",
            "-i", str(concat_file),
            "-c:v", "libx264",
            "-preset", "medium",
            "-crf", str(self._get_crf()),
            "-r", str(fps),
            "-s", f"{resolution['width']}x{resolution['height']}",
        ])

        if include_audio:
            cmd.extend(["-c:a", "aac", "-b:a", "192k"])
        else:
            cmd.append("-an")

        # Watermark
        watermark: str = self.config.get("watermark", "")
        if watermark:
            cmd.extend([
                "-vf",
                f"drawtext=text='{watermark}':fontcolor=white@0.5:fontsize=24:"
                f"x=w-tw-10:y=h-th-10",
            ])

        cmd.append(output_path)
        self._concat_file = concat_file
        self._output_path = output_path
        return cmd

    def _build_filter_complex_concat(self, cmd: List[str]) -> List[str]:
        """
        Build command using filter_complex with trim+concat.
        Handles per-segment filters (speed, color, text) without transitions.
        """
        output_path: str = self._get_output_path()
        resolution: Dict[str, int] = self._get_resolution()
        fps: int = self.config.get("fps", 30)
        include_audio: bool = self.config.get("include_audio", True)

        # Add all inputs
        for seg in self.segments:
            material_path: str = self._get_material_path(
                seg.get("material_id", seg.get("materialId", ""))
            )
            cmd.extend(["-i", material_path])

        # Build filter chains
        filter_parts: List[str] = []
        seg_labels: List[str] = []

        for i, seg in enumerate(self.segments):
            start: float = float(seg.get("start_time", seg.get("startTime", 0)))
            end: float = float(seg.get("end_time", seg.get("endTime", start + 3)))
            seg_duration: float = end - start
            speed: float = float(seg.get("speed", 1.0))
            label: str = f"s{i}"

            chain: List[str] = [f"[{i}:v]"]
            chain.append(f"trim=start={start}:duration={seg_duration}")
            chain.append("setpts=PTS-STARTPTS")

            if speed != 1.0:
                chain.append(f"setpts={1.0 / speed}*PTS")

            chain.append(
                f"scale={resolution['width']}:{resolution['height']}:"
                f"force_original_aspect_ratio=decrease"
            )
            chain.append(
                f"pad={resolution['width']}:{resolution['height']}:(ow-iw)/2:(oh-ih)/2"
            )

            # Visual filters
            for flt in seg.get("filters", []):
                f_type: str = flt.get("type", "")
                f_val: float = float(flt.get("value", 100))
                if f_type == "brightness":
                    chain.append(f"eq=brightness={f_val / 100.0 - 1.0}")
                elif f_type == "contrast":
                    chain.append(f"eq=contrast={f_val / 100.0}")
                elif f_type == "saturation":
                    chain.append(f"eq=saturation={f_val / 100.0}")
                elif f_type == "blur" and f_val > 0:
                    chain.append(f"boxblur={f_val}")
                elif f_type == "sharpen" and f_val > 0:
                    chain.append(f"unsharp=5:5:{f_val / 10.0}")

            # Text overlay
            to: Optional[Dict[str, Any]] = seg.get("text_overlay", seg.get("textOverlay"))
            if to and to.get("text"):
                txt: str = to["text"].replace("'", "\\'").replace(":", "\\:")
                font_size: int = int(to.get("font_size", to.get("fontSize", 32)))
                color: str = to.get("color", "white")
                pos: str = to.get("position", "bottom-center")
                pos_map: Dict[str, str] = {
                    "top-left": "x=10:y=10",
                    "top-center": "x=(w-text_w)/2:y=10",
                    "top-right": "x=w-tw-10:y=10",
                    "center": "x=(w-text_w)/2:y=(h-text_h)/2",
                    "bottom-left": "x=10:y=h-th-10",
                    "bottom-center": "x=(w-text_w)/2:y=h-th-10",
                    "bottom-right": "x=w-tw-10:y=h-th-10",
                }
                ps: str = pos_map.get(pos, "x=(w-text_w)/2:y=h-th-10")
                chain.append(
                    f"drawtext=text='{txt}':fontsize={font_size}:fontcolor={color}:{ps}:borderw=2"
                )

            chain.append(f"fps={fps}")
            chain.append("setpts=PTS-STARTPTS")
            filter_parts.append(";".join(chain) + f"[{label}]")
            seg_labels.append(label)

        # Concat all segments
        if len(seg_labels) == 1:
            filter_parts.append(f"[{seg_labels[0]}]null[outv]")
        else:
            concat_inputs: str = "".join(f"[{l}]" for l in seg_labels)
            filter_parts.append(f"{concat_inputs}concat=n={len(seg_labels)}:v=1:a=0[outv]")

        # Watermark
        watermark: str = self.config.get("watermark", "")
        if watermark:
            filter_parts.append(
                f"[outv]drawtext=text='{watermark}':fontcolor=white@0.5:fontsize=24:"
                f"x=w-tw-10:y=h-th-10[vout]"
            )
            output_video_label: str = "vout"
        else:
            output_video_label = "outv"

        filter_complex: str = ";".join(filter_parts)

        cmd.extend([
            "-filter_complex", filter_complex,
            "-map", f"[{output_video_label}]",
            "-c:v", "libx264",
            "-preset", "medium",
            "-crf", str(self._get_crf()),
        ])

        if include_audio:
            cmd.extend(["-map", "0:a?", "-c:a", "aac", "-b:a", "192k", "-shortest"])
        else:
            cmd.append("-an")

        cmd.append(output_path)
        self._output_path = output_path
        return cmd

    def _build_xfade_command(self, cmd: List[str]) -> List[str]:
        """
        Build command using xfade filter for cross-fade transitions.

        Complex filter chain:
        [0:v]trim=0:3,setpts=PTS-STARTPTS,scale=1920:1080[v0];
        [1:v]trim=0:3,setpts=PTS-STARTPTS,scale=1920:1080[v1];
        [v0][v1]xfade=transition=fade:duration=0.5:offset=2.5[vt01];
        ...
        """
        output_path: str = self._get_output_path()

        # Add all inputs
        for seg in self.segments:
            material_path: str = self._get_material_path(
                seg.get("material_id", seg.get("materialId", ""))
            )
            cmd.extend(["-i", material_path])

        # Build complex filter graph
        filter_parts: List[str] = []
        resolution: Dict[str, int] = self._get_resolution()
        fps: int = self.config.get("fps", 30)
        quality: str = self.config.get("quality", "medium")
        include_audio: bool = self.config.get("include_audio", True)

        # Per-segment filters
        seg_labels: List[str] = []
        for i, seg in enumerate(self.segments):
            start_time: float = float(seg.get("start_time", seg.get("startTime", 0)))
            end_time: float = float(seg.get("end_time", seg.get("endTime", start_time + 3)))
            seg_duration: float = end_time - start_time
            speed: float = float(seg.get("speed", 1.0))
            label: str = f"v{i}"

            filter_chain: List[str] = []
            filter_chain.append(f"[{i}:v]")
            filter_chain.append(f"trim=start={start_time}:duration={seg_duration}")
            filter_chain.append("setpts=PTS-STARTPTS")

            # Speed adjustment
            if speed != 1.0:
                filter_chain.append(f"setpts={1.0 / speed}*PTS")

            # Scale to target resolution
            filter_chain.append(f"scale={resolution['width']}:{resolution['height']}:force_original_aspect_ratio=decrease")
            filter_chain.append(f"pad={resolution['width']}:{resolution['height']}:(ow-iw)/2:(oh-ih)/2")

            # Apply visual filters
            for f in seg.get("filters", []):
                f_type: str = f.get("type", "")
                f_value: float = float(f.get("value", 100))
                if f_type == "brightness":
                    filter_chain.append(f"eq=brightness={f_value / 100.0 - 1.0}")
                elif f_type == "contrast":
                    filter_chain.append(f"eq=contrast={f_value / 100.0}")
                elif f_type == "saturation":
                    filter_chain.append(f"eq=saturation={f_value / 100.0}")
                elif f_type == "blur" and f_value > 0:
                    filter_chain.append(f"boxblur={f_value}")
                elif f_type == "sharpen" and f_value > 0:
                    filter_chain.append(f"unsharp=5:5:{f_value / 10.0}")

            # Text overlay
            text_overlay: Optional[Dict[str, Any]] = seg.get(
                "text_overlay", seg.get("textOverlay")
            )
            if text_overlay and text_overlay.get("text"):
                txt: str = text_overlay["text"].replace("'", "\\'")
                font_size: int = int(text_overlay.get("font_size", text_overlay.get("fontSize", 32)))
                color: str = text_overlay.get("color", "white")
                pos: str = text_overlay.get("position", "bottom-center")
                position_map: Dict[str, str] = {
                    "top-left": "x=10:y=10",
                    "top-center": "x=(w-text_w)/2:y=10",
                    "top-right": "x=w-tw-10:y=10",
                    "center": "x=(w-text_w)/2:y=(h-text_h)/2",
                    "bottom-left": "x=10:y=h-th-10",
                    "bottom-center": "x=(w-text_w)/2:y=h-th-10",
                    "bottom-right": "x=w-tw-10:y=h-th-10",
                }
                pos_str: str = position_map.get(pos, "x=(w-text_w)/2:y=h-th-10")
                filter_chain.append(
                    f"drawtext=text='{txt}':fontsize={font_size}:fontcolor={color}:{pos_str}:borderw=2"
                )

            # FPS
            filter_chain.append(f"fps={fps}")

            # Set PTS for uniform timestamps
            filter_chain.append("setpts=PTS-STARTPTS")

            filter_parts.append(";".join(filter_chain) + f"[{label}]")
            seg_labels.append(label)

        # Build xfade chain
        if len(seg_labels) == 1:
            filter_parts.append(f"[{seg_labels[0]}]null[outv]")
        else:
            current_label: str = seg_labels[0]
            cumulative_duration: float = 0.0

            for i in range(1, len(seg_labels)):
                seg: Dict[str, Any] = self.segments[i - 1]
                start_time: float = float(seg.get("start_time", seg.get("startTime", 0)))
                end_time: float = float(seg.get("end_time", seg.get("endTime", start_time + 3)))
                seg_duration: float = end_time - start_time
                speed: float = float(seg.get("speed", 1.0))
                effective_duration: float = seg_duration / speed

                transition: Dict[str, Any] = seg.get(
                    "transition_out", seg.get("transitionOut", {})
                )
                trans_type: str = transition.get("type", "none")
                trans_duration: float = float(transition.get("duration", 0.3))

                cumulative_duration += effective_duration
                offset: float = cumulative_duration - trans_duration

                next_label: str = f"vt{i}"
                if trans_type == "none" or trans_duration <= 0:
                    # Simple concat via overlay (overlay last frame)
                    filter_parts.append(
                        f"[{current_label}][{seg_labels[i]}]concat=n=2:v=1:a=0[{next_label}]"
                    )
                else:
                    xfade_type: str = TRANSITION_XFADE_MAP.get(trans_type, "fade")
                    filter_parts.append(
                        f"[{current_label}][{seg_labels[i]}]"
                        f"xfade=transition={xfade_type}:duration={trans_duration}:offset={offset:.3f}"
                        f"[{next_label}]"
                    )
                current_label = next_label

            filter_parts.append(f"[{current_label}]null[outv]")

        filter_complex: str = ";".join(filter_parts)
        cmd.extend([
            "-filter_complex", filter_complex,
            "-map", "[outv]",
            "-c:v", "libx264",
            "-preset", "medium",
            "-crf", str(self._get_crf()),
            "-r", str(fps),
        ])

        # Audio handling
        if include_audio and len(self.segments) > 0:
            # Map first segment's audio, or mix all
            cmd.extend(["-map", "0:a?", "-c:a", "aac", "-b:a", "192k", "-shortest"])
        else:
            cmd.append("-an")

        cmd.append(output_path)
        self._output_path = output_path
        return cmd

    def _build_gif_command(self, cmd: List[str]) -> List[str]:
        """
        Build GIF output command using palettegen + paletteuse for quality.

        Two-pass approach:
        1. Generate palette from source
        2. Use palette to create dithered GIF
        """
        output_path: str = self._get_output_path()
        fps: int = self.config.get("fps", 30)
        resolution: Dict[str, int] = self._get_resolution()

        # Build concat input first (simplified — process all segments)
        # For GIF, we use a simpler approach: concat all inputs with filters
        concat_file: Path = TEMP_DIR / f"concat_{uuid.uuid4().hex[:8]}.txt"
        temp_list: str = ""

        for seg in self.segments:
            material_path: str = self._get_material_path(
                seg.get("material_id", seg.get("materialId", ""))
            )
            cmd.extend(["-i", material_path])
            # We'll use concat filter, not file list for GIF
            temp_list += material_path + "\n"

        # For simplicity with GIF, build a filter complex that concats and scales,
        # then applies palettegen/paletteuse
        filter_parts: List[str] = []
        seg_inputs: List[str] = []

        for i, seg in enumerate(self.segments):
            start_time: float = float(seg.get("start_time", seg.get("startTime", 0)))
            end_time: float = float(seg.get("end_time", seg.get("endTime", start_time + 3)))
            seg_duration: float = end_time - start_time
            speed: float = float(seg.get("speed", 1.0))
            label: str = f"s{i}"

            filter_chain: List[str] = []
            filter_chain.append(f"[{i}:v]")
            filter_chain.append(f"trim=start={start_time}:duration={seg_duration}")
            filter_chain.append("setpts=PTS-STARTPTS")

            if speed != 1.0:
                filter_chain.append(f"setpts={1.0 / speed}*PTS")

            filter_chain.append(f"fps={fps}")
            filter_chain.append(
                f"scale={resolution['width']}:{resolution['height']}:"
                f"force_original_aspect_ratio=decrease"
            )
            filter_chain.append(
                f"pad={resolution['width']}:{resolution['height']}:(ow-iw)/2:(oh-ih)/2"
            )
            filter_chain.append("setpts=PTS-STARTPTS")

            filter_parts.append(";".join(filter_chain) + f"[{label}]")
            seg_inputs.append(label)

        # Concat all segments
        if len(seg_inputs) == 1:
            concat_label: str = seg_inputs[0]
        else:
            concat_filter: str = f"[{''.join(f'[{l}]' for l in seg_inputs)}]concat=n={len(seg_inputs)}:v=1:a=0[concat]"
            filter_parts.append(concat_filter)
            concat_label = "concat"

        # Palettegen + paletteuse for better GIF quality
        filter_parts.append(f"[{concat_label}]split[vid][pal]")
        filter_parts.append("[pal]palettegen=stats_mode=diff[palette]")
        filter_parts.append("[vid][palette]paletteuse=dither=bayer:bayer_scale=5[outv]")

        filter_complex: str = ";".join(filter_parts)

        cmd.extend([
            "-filter_complex", filter_complex,
            "-map", "[outv]",
            "-f", "gif",
            output_path,
        ])

        self._concat_file = concat_file
        self._output_path = output_path
        return cmd

    def _get_output_path(self) -> str:
        """Generate the output file path."""
        output_format: str = self.config.get("output_format", "mp4")
        template_name: str = self.template.get("name", "untitled")
        safe_name: str = "".join(
            c for c in template_name if c.isalnum() or c in " _-"
        ).rstrip()
        if not safe_name:
            safe_name = "untitled"
        timestamp: str = datetime.now().strftime("%Y%m%d_%H%M%S")
        ext: str = ".mp4" if output_format == "mp4" else f".{output_format}"
        filename: str = f"{safe_name}_{timestamp}{ext}"
        return str(OUTPUT_DIR / filename)

    def _get_resolution(self) -> Dict[str, int]:
        """Get target resolution dimensions."""
        res: str = self.config.get("resolution", "1080p")
        res_map: Dict[str, Dict[str, int]] = {
            "720p": {"width": 1280, "height": 720},
            "1080p": {"width": 1920, "height": 1080},
        }
        target = res_map.get(res, {"width": 1920, "height": 1080})

        # If 'original', try to detect from first segment's material
        if res == "original" and self.segments:
            first_seg = self.segments[0]
            mat_id: str = first_seg.get("material_id", first_seg.get("materialId", ""))
            for mat in self.materials:
                if mat.get("id") == mat_id:
                    w: int = mat.get("width", 1920)
                    h: int = mat.get("height", 1080)
                    return {"width": w, "height": h}

        return {"width": target["width"], "height": target["height"]}

    def _get_crf(self) -> int:
        """Get CRF value based on quality preset."""
        quality: str = self.config.get("quality", "medium")
        crf_map: Dict[str, int] = {"low": 28, "medium": 23, "high": 18}
        return crf_map.get(quality, 23)

    @property
    def output_path(self) -> str:
        return getattr(self, "_output_path", "")

    @property
    def temp_files_to_cleanup(self) -> List[Path]:
        """Get list of temp files that should be cleaned up after rendering."""
        result: List[Path] = []
        if hasattr(self, "_concat_file"):
            result.append(self._concat_file)
        if hasattr(self, "_temp_files"):
            result.extend(self._temp_files)
        return result


# ─── Render Engine ────────────────────────────────────────────

class RenderEngine:
    """
    Async video renderer using FFmpeg subprocess.

    Features:
    - Progress parsing from FFmpeg stderr (frame=N)
    - Timeout control (30 minutes max)
    - Cleanup of temp files
    - Thumbnail generation on completion
    - Error capture and reporting
    """

    def __init__(self):
        self._current_process: Optional[asyncio.subprocess.Process] = None
        self._is_cancelled: bool = False

    async def render(
        self,
        template: Dict[str, Any],
        materials: List[Dict[str, Any]],
        config: Dict[str, Any],
        job_id: str,
        progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None,
    ) -> Dict[str, Any]:
        """
        Execute the render process.

        Args:
            template: Template dict with segments
            materials: List of material dicts with file_path
            config: Render configuration dict
            job_id: Unique job identifier
            progress_callback: Optional async callback for progress updates

        Returns:
            Dict with render result (output_path, duration, file_size, thumbnail)
        """
        self._is_cancelled = False

        # Build FFmpeg command
        builder: FFmpegCommandBuilder = FFmpegCommandBuilder(
            template, materials, config
        )
        cmd: List[str] = builder.build()

        # Execute FFmpeg
        try:
            self._current_process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )

            # Parse stderr for progress
            total_duration: float = self._calculate_total_duration()
            total_frames: int = int(total_duration * config.get("fps", 30))

            stderr_task: asyncio.Task = asyncio.create_task(
                self._parse_progress(
                    self._current_process,
                    total_frames,
                    progress_callback,
                    job_id,
                )
            )

            try:
                await asyncio.wait_for(
                    self._current_process.wait(), timeout=RENDER_TIMEOUT_SEC
                )
            except asyncio.TimeoutError:
                self._current_process.kill()
                await self._current_process.wait()
                return {
                    "success": False,
                    "error": "Render timed out after 30 minutes",
                    "error_code": ErrorCode.FFMPEG_FAILED,
                }

            await stderr_task

            if self._is_cancelled:
                return {
                    "success": False,
                    "error": "Render was cancelled",
                    "error_code": ErrorCode.CANCEL_FAILED,
                }

            if self._current_process.returncode != 0:
                stderr_text: str = ""
                if self._current_process.stderr:
                    try:
                        stderr_bytes: bytes = await self._current_process.stderr.read()
                        stderr_text = stderr_bytes.decode("utf-8", errors="replace")[-500:]
                    except Exception:
                        pass
                return {
                    "success": False,
                    "error": f"FFmpeg exited with code {self._current_process.returncode}: {stderr_text}",
                    "error_code": ErrorCode.FFMPEG_FAILED,
                }

            # Render succeeded
            output_path: str = builder.output_path
            file_size: int = os.path.getsize(output_path) if os.path.isfile(output_path) else 0

            # Generate thumbnail (frame at 3 seconds)
            thumbnail_base64: str = await self._generate_thumbnail(output_path)

            # Cleanup temp files
            for temp_file in builder.temp_files_to_cleanup:
                try:
                    if os.path.isfile(temp_file):
                        os.remove(temp_file)
                except OSError:
                    pass

            return {
                "success": True,
                "output_path": output_path,
                "file_size": file_size,
                "thumbnail": thumbnail_base64,
            }

        except FileNotFoundError as e:
            return {
                "success": False,
                "error": str(e),
                "error_code": ErrorCode.FFMPEG_NOT_FOUND,
            }
        except ValueError as e:
            return {
                "success": False,
                "error": str(e),
                "error_code": ErrorCode.TEMPLATE_INVALID,
            }
        except Exception as e:
            return {
                "success": False,
                "error": f"Render error: {str(e)}",
                "error_code": ErrorCode.INTERNAL_ERROR,
            }
        finally:
            self._current_process = None

    async def cancel(self) -> None:
        """Cancel the current render process."""
        self._is_cancelled = True
        if self._current_process and self._current_process.returncode is None:
            try:
                self._current_process.kill()
            except Exception:
                pass

    def _calculate_total_duration(self) -> float:
        """Calculate total output duration from all segments."""
        total: float = 0.0
        for seg in (self.segments if hasattr(self, 'segments') else []):
            # Not available at this point; return rough estimate
            pass
        return 60.0  # Fallback

    async def _parse_progress(
        self,
        process: asyncio.subprocess.Process,
        total_frames: int,
        progress_callback: Optional[Callable],
        job_id: str,
    ) -> None:
        """
        Parse FFmpeg stderr output for progress information.

        FFmpeg outputs lines like:
          frame=  123 fps=30.0 ... time=00:00:04.10 ... speed=1.5x
        """
        if not process.stderr or not progress_callback:
            return

        try:
            while True:
                line_bytes: bytes = await process.stderr.readline()
                if not line_bytes:
                    break

                line: str = line_bytes.decode("utf-8", errors="replace").strip()

                # Parse frame number
                if "frame=" in line:
                    try:
                        frame_part: str = line.split("frame=")[1].split()[0].strip()
                        current_frame: int = int(frame_part)

                        # Parse time
                        time_str: str = "00:00:00"
                        if "time=" in line:
                            time_str = line.split("time=")[1].split()[0].strip()

                        # Parse speed
                        speed_str: str = "1x"
                        if "speed=" in line:
                            speed_str = line.split("speed=")[1].split()[0].strip()

                        # Calculate progress
                        if total_frames > 0:
                            progress: float = min(100.0, (current_frame / total_frames) * 100)
                        else:
                            progress = 0.0

                        # Calculate estimated remaining time
                        estimated_remaining: float = 0.0
                        if current_frame > 0 and total_frames > 0:
                            speed_val: float = float(speed_str.replace("x", "")) if speed_str else 1.0
                            remaining_frames: int = total_frames - current_frame
                            if speed_val > 0:
                                estimated_remaining = remaining_frames / (30.0 * speed_val)

                        await progress_callback({
                            "job_id": job_id,
                            "progress": round(progress, 1),
                            "current_step": f"正在编码第 {current_frame}/{total_frames} 帧...",
                            "estimated_remaining": round(estimated_remaining, 1),
                            "frames_processed": current_frame,
                            "total_frames": total_frames,
                        })
                    except (ValueError, IndexError):
                        pass
        except Exception:
            pass

    async def _generate_thumbnail(self, video_path: str) -> str:
        """Generate a base64-encoded JPEG thumbnail at 3 seconds into the video."""
        import base64

        thumb_path: Path = TEMP_DIR / f"thumb_{uuid.uuid4().hex[:8]}.jpg"

        try:
            ffmpeg_path: str = get_ffmpeg_path()
            proc = await asyncio.create_subprocess_exec(
                ffmpeg_path,
                "-y",
                "-ss", "3",
                "-i", video_path,
                "-vframes", "1",
                "-q:v", "2",
                "-s", "320x180",
                str(thumb_path),
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await proc.wait()

            if os.path.isfile(thumb_path) and os.path.getsize(thumb_path) > 0:
                with open(thumb_path, "rb") as f:
                    img_data: bytes = f.read()
                return base64.b64encode(img_data).decode("utf-8")

        except Exception:
            pass
        finally:
            try:
                if os.path.isfile(thumb_path):
                    os.remove(thumb_path)
            except OSError:
                pass

        return ""


# ─── Render Queue ─────────────────────────────────────────────

class RenderQueue:
    """
    In-memory render job queue with JSON file persistence.

    - Max concurrent renders = 1 (serial execution)
    - Jobs persisted to backend/data/renders/{job_id}.json
    - Notifies on job completion
    """

    def __init__(self):
        self._queue: asyncio.Queue = asyncio.Queue(maxsize=100)
        self._jobs: Dict[str, Dict[str, Any]] = {}
        self._engine: RenderEngine = RenderEngine()
        self._is_running: bool = False
        self._current_job_id: Optional[str] = None

        # Load persisted jobs
        self._load_persisted_jobs()

    def _load_persisted_jobs(self) -> None:
        """Load jobs from persisted JSON files."""
        if not RENDERS_DIR.exists():
            return
        for file_path in RENDERS_DIR.glob("*.json"):
            try:
                with open(file_path, "r", encoding="utf-8") as f:
                    job_data: Dict[str, Any] = json.load(f)
                job_id: str = job_data.get("id", "")
                if job_id:
                    self._jobs[job_id] = job_data
            except (json.JSONDecodeError, IOError):
                pass

    def _persist_job(self, job_id: str) -> None:
        """Save a job to its JSON file."""
        job: Optional[Dict[str, Any]] = self._jobs.get(job_id)
        if not job:
            return
        file_path: Path = RENDERS_DIR / f"{job_id}.json"
        try:
            with open(file_path, "w", encoding="utf-8") as f:
                json.dump(job, f, ensure_ascii=False, indent=2, default=str)
        except IOError:
            pass

    def _delete_persisted_job(self, job_id: str) -> None:
        """Delete a job's JSON file."""
        file_path: Path = RENDERS_DIR / f"{job_id}.json"
        try:
            if file_path.exists():
                file_path.unlink()
        except OSError:
            pass

    def create_job(
        self,
        template: Dict[str, Any],
        materials: List[Dict[str, Any]],
        config: Dict[str, Any],
        template_name: str = "",
    ) -> Dict[str, Any]:
        """Create a new render job and add it to the queue."""
        job_id: str = uuid.uuid4().hex[:12]
        now: str = datetime.now(timezone.utc).isoformat()

        job: Dict[str, Any] = {
            "id": job_id,
            "template_id": template.get("id", ""),
            "template_name": template_name or template.get("name", "未命名"),
            "status": "pending",
            "progress": 0,
            "output_path": "",
            "output_format": config.get("output_format", "mp4"),
            "resolution": config.get("resolution", "1080p"),
            "fps": config.get("fps", 30),
            "quality": config.get("quality", "medium"),
            "started_at": now,
            "completed_at": "",
            "estimated_remaining": 0,
            "error": "",
            "current_step": "等待渲染...",
            "thumbnail": "",
            "config": config,
            "_template": template,
            "_materials": materials,
        }

        self._jobs[job_id] = job
        self._persist_job(job_id)

        # Auto-start: add to asyncio queue
        try:
            self._queue.put_nowait(job_id)
        except asyncio.QueueFull:
            pass

        # Ensure worker is running
        if not self._is_running:
            self._is_running = True
            asyncio.create_task(self._worker())

        return job

    async def _worker(self) -> None:
        """Background worker that processes the job queue serially."""
        while True:
            try:
                job_id: str = await self._queue.get()
            except Exception:
                break

            job: Optional[Dict[str, Any]] = self._jobs.get(job_id)
            if not job:
                self._queue.task_done()
                continue

            # Skip if already completed/failed/cancelled
            if job["status"] in ("completed", "failed", "cancelled"):
                self._queue.task_done()
                continue

            self._current_job_id = job_id

            # Update status
            job["status"] = "processing"
            job["current_step"] = "正在初始化渲染..."
            job["started_at"] = datetime.now(timezone.utc).isoformat()
            self._persist_job(job_id)

            # Progress callback
            async def on_progress(progress_data: Dict[str, Any]) -> None:
                j: Optional[Dict[str, Any]] = self._jobs.get(job_id)
                if not j:
                    return
                j["progress"] = progress_data.get("progress", 0)
                j["current_step"] = progress_data.get("current_step", "")
                j["estimated_remaining"] = progress_data.get("estimated_remaining", 0)
                # Persist every 10% to reduce I/O
                if int(j["progress"]) % 10 == 0:
                    self._persist_job(job_id)

            # Execute render
            try:
                result: Dict[str, Any] = await self._engine.render(
                    template=job["_template"],
                    materials=job["_materials"],
                    config=job["config"],
                    job_id=job_id,
                    progress_callback=on_progress,
                )

                if result.get("success"):
                    job["status"] = "completed"
                    job["progress"] = 100
                    job["output_path"] = result.get("output_path", "")
                    job["thumbnail"] = result.get("thumbnail", "")
                    job["current_step"] = "渲染完成"
                    job["completed_at"] = datetime.now(timezone.utc).isoformat()
                else:
                    job["status"] = "failed"
                    job["error"] = result.get("error", "Unknown error")
                    job["current_step"] = "渲染失败"
                    job["completed_at"] = datetime.now(timezone.utc).isoformat()

            except Exception as e:
                job["status"] = "failed"
                job["error"] = str(e)
                job["current_step"] = "渲染异常"
                job["completed_at"] = datetime.now(timezone.utc).isoformat()

            # Clean up internal data
            job.pop("_template", None)
            job.pop("_materials", None)

            self._persist_job(job_id)
            self._current_job_id = None
            self._queue.task_done()

        self._is_running = False

    def get_job(self, job_id: str) -> Optional[Dict[str, Any]]:
        """Get a job by ID."""
        return self._jobs.get(job_id)

    def get_all_jobs(self) -> List[Dict[str, Any]]:
        """Get all jobs."""
        return [
            {k: v for k, v in job.items() if not k.startswith("_")}
            for job in self._jobs.values()
        ]

    def cancel_job(self, job_id: str) -> bool:
        """Cancel a job."""
        job: Optional[Dict[str, Any]] = self._jobs.get(job_id)
        if not job:
            return False

        if job["status"] in ("pending", "queued"):
            job["status"] = "cancelled"
            job["current_step"] = "已取消"
            job["completed_at"] = datetime.now(timezone.utc).isoformat()
            self._persist_job(job_id)
            return True

        if job["status"] == "processing":
            # Trigger async cancel
            asyncio.create_task(self._engine.cancel())
            job["status"] = "cancelled"
            job["current_step"] = "正在取消..."
            job["completed_at"] = datetime.now(timezone.utc).isoformat()
            self._persist_job(job_id)
            return True

        return False

    def delete_job(self, job_id: str) -> bool:
        """Delete a job that is not currently processing."""
        job: Optional[Dict[str, Any]] = self._jobs.get(job_id)
        if not job:
            return False

        if job["status"] in ("processing", "queued"):
            return False

        self._delete_persisted_job(job_id)
        self._jobs.pop(job_id, None)
        return True

    def get_output_file_path(self, job_id: str) -> Optional[str]:
        """Get the output file path for a completed job."""
        job: Optional[Dict[str, Any]] = self._jobs.get(job_id)
        if not job or job["status"] != "completed":
            return None
        output_path: str = job.get("output_path", "")
        if output_path and os.path.isfile(output_path):
            return output_path
        return None


# ─── Singleton instance ───────────────────────────────────────

_render_queue_instance: Optional[RenderQueue] = None


def get_render_queue() -> RenderQueue:
    """Get or create the singleton RenderQueue instance."""
    global _render_queue_instance
    if _render_queue_instance is None:
        _render_queue_instance = RenderQueue()
    return _render_queue_instance
