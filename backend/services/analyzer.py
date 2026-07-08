"""
Analysis engine for smart material analysis.

Provides:
- Scene detection via histogram difference (OpenCV primary, PIL fallback)
- Quality assessment (brightness, contrast, sharpness, stability, audio)
- Tag generation via heuristic rules
- Highlight finding via scene change intensity + color richness

The engine can run with either OpenCV (cv2) or PIL as the image backend.
All analysis runs synchronously and should be invoked from a background thread.
"""

import os
import math
import json
import uuid
import time
import tempfile
import subprocess
from pathlib import Path
from typing import Optional, Any
from dataclasses import dataclass, field
from enum import Enum

import numpy as np

from config import FFMPEG_EXECUTABLE

# ─── Optional OpenCV import ───────────────────────────────────

try:
    import cv2

    HAS_OPENCV: bool = True
except ImportError:
    HAS_OPENCV = False

# ─── PIL fallback ─────────────────────────────────────────────

try:
    from PIL import Image as PILImage

    HAS_PIL: bool = True
except ImportError:
    HAS_PIL = False


# ─── Constants ────────────────────────────────────────────────

# Scene detection thresholds
DEFAULT_SCENE_THRESHOLD: float = 30.0  # histogram diff threshold
MIN_SCENE_DURATION_SEC: float = 0.5    # minimum scene length
SCENE_SAMPLE_INTERVAL_SEC: float = 0.5 # sample a frame every N seconds

# Quality defaults
IDEAL_BRIGHTNESS: float = 128.0
BRIGHTNESS_SCORE_WEIGHT: float = 0.20
CONTRAST_SCORE_WEIGHT: float = 0.25
SHARPNESS_SCORE_WEIGHT: float = 0.30
STABILITY_SCORE_WEIGHT: float = 0.15
AUDIO_SCORE_WEIGHT: float = 0.10

# Highlight thresholds
HIGHLIGHT_SCENE_CHANGE_WEIGHT: float = 0.5
HIGHLIGHT_COLOR_WEIGHT: float = 0.5
HIGHLIGHT_MIN_SCORE: float = 30.0
MAX_HIGHLIGHTS: int = 10

# Tag generation
BRIGHT_BRIGHTNESS_THRESHOLD: float = 150.0
DARK_BRIGHTNESS_THRESHOLD: float = 80.0
HIGH_CONTRAST_THRESHOLD: float = 60.0
HIGH_SHARPNESS_THRESHOLD: float = 200.0
DYNAMIC_SCENE_THRESHOLD: float = 0.6  # scene change rate


# ─── Data Classes ─────────────────────────────────────────────

class AnalysisSubStep(str, Enum):
    """Analysis sub-step identifiers."""
    SCENE_DETECTION = "scene_detection"
    QUALITY_ANALYSIS = "quality_analysis"
    TAG_GENERATION = "tag_generation"
    HIGHLIGHT_DETECTION = "highlight_detection"


@dataclass
class SceneResult:
    """A single detected scene."""
    id: str
    start_time: float
    end_time: float
    thumbnail: str  # base64 JPEG
    description: str
    confidence: float


@dataclass
class QualityResult:
    """Quality assessment result."""
    brightness: float
    contrast: float
    sharpness: float
    stability: float
    audio_quality: float
    overall_score: float


@dataclass
class TagResult:
    """A generated tag."""
    id: str
    label: str
    category: str  # content | style | technical | scene


@dataclass
class HighlightResult:
    """A detected highlight moment."""
    id: str
    time_range: tuple[float, float]
    score: float
    reason: str
    thumbnail: str  # base64 JPEG


@dataclass
class AnalysisOutput:
    """Complete analysis output for a material."""
    analysis_id: str
    material_id: str
    status: str               # pending | processing | done | error
    scene_count: int
    total_duration: float
    quality_score: float
    tags: list[TagResult] = field(default_factory=list)
    scenes: list[SceneResult] = field(default_factory=list)
    highlights: list[HighlightResult] = field(default_factory=list)
    quality_report: Optional[QualityResult] = None
    progress: float = 0.0
    error_message: str = ""
    analyzed_at: str = ""


# ─── Video Reader Abstraction ─────────────────────────────────

class VideoReader:
    """
    Abstract video reading using cv2 or ffmpeg pipe.
    """

    def __init__(self, file_path: str):
        self.file_path: str = file_path
        self._cap: Any = None
        self._width: int = 0
        self._height: int = 0
        self._fps: float = 0.0
        self._frame_count: int = 0
        self._duration: float = 0.0

        if HAS_OPENCV:
            self._init_cv2()
        else:
            self._init_probe()

    def _init_cv2(self) -> None:
        """Initialize with OpenCV."""
        cap = cv2.VideoCapture(self.file_path)
        if not cap.isOpened():
            raise RuntimeError(f"Cannot open video: {self.file_path}")
        self._cap = cap
        self._width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        self._height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        self._fps = float(cap.get(cv2.CAP_PROP_FPS))
        self._frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        if self._fps > 0:
            self._duration = self._frame_count / self._fps
        else:
            self._duration = 0.0

    def _init_probe(self) -> None:
        """Use ffprobe to get video metadata when OpenCV is unavailable."""
        import json as _json
        cmd: list[str] = [
            "ffprobe", "-v", "quiet", "-print_format", "json",
            "-show_format", "-show_streams", self.file_path,
        ]
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
            if result.returncode == 0:
                data = _json.loads(result.stdout)
                fmt = data.get("format", {})
                self._duration = float(fmt.get("duration", 0))
                for stream in data.get("streams", []):
                    if stream.get("codec_type") == "video":
                        self._width = stream.get("width", 0)
                        self._height = stream.get("height", 0)
                        fps_str = stream.get("r_frame_rate", "0/1")
                        try:
                            n, d = fps_str.split("/")
                            if int(d) != 0:
                                self._fps = float(n) / float(d)
                        except (ValueError, ZeroDivisionError):
                            self._fps = 0.0
                        break
        except (FileNotFoundError, subprocess.TimeoutExpired, json.JSONDecodeError):
            self._duration = 0.0

    @property
    def width(self) -> int:
        return self._width

    @property
    def height(self) -> int:
        return self._height

    @property
    def fps(self) -> float:
        return self._fps

    @property
    def frame_count(self) -> int:
        return self._frame_count

    @property
    def duration(self) -> float:
        return self._duration

    def read_frame_at_time(self, time_sec: float) -> Optional[np.ndarray]:
        """Read a single frame at the specified time position."""
        if self._cap is not None:
            # OpenCV: seek using frame index
            frame_idx = int(time_sec * self._fps)
            self._cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
            ret, frame = self._cap.read()
            if ret:
                # Convert BGR to RGB
                return cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            return None
        else:
            # PIL fallback: use ffmpeg to extract frame
            return self._extract_frame_ffmpeg(time_sec)

    def _extract_frame_ffmpeg(self, time_sec: float) -> Optional[np.ndarray]:
        """Extract a frame using ffmpeg pipe."""
        tmp_fd, tmp_path = tempfile.mkstemp(suffix=".jpg")
        os.close(tmp_fd)
        try:
            cmd: list[str] = [
                FFMPEG_EXECUTABLE, "-ss", str(time_sec),
                "-i", self.file_path,
                "-vframes", "1",
                "-q:v", "5",
                "-y", tmp_path,
            ]
            subprocess.run(cmd, capture_output=True, timeout=15)
            if os.path.exists(tmp_path) and os.path.getsize(tmp_path) > 0:
                if HAS_PIL:
                    img = PILImage.open(tmp_path).convert("RGB")
                    return np.array(img)
                else:
                    # Read raw JPEG bytes as numpy
                    with open(tmp_path, "rb") as f:
                        raw = f.read()
                    # Use numpy to decode JPEG via PIL
                    from io import BytesIO
                    img = PILImage.open(BytesIO(raw)).convert("RGB")
                    return np.array(img)
        except Exception:
            pass
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
        return None

    def read_frames_at_intervals(
        self, interval_sec: float
    ) -> list[tuple[float, np.ndarray]]:
        """Read frames at regular intervals throughout the video."""
        frames: list[tuple[float, np.ndarray]] = []
        if self._duration <= 0:
            return frames

        t: float = 0.0
        while t < self._duration:
            frame = self.read_frame_at_time(t)
            if frame is not None:
                frames.append((t, frame))
            t += interval_sec
        return frames

    def close(self) -> None:
        """Release resources."""
        if self._cap is not None:
            self._cap.release()


# ─── Histogram Calculator (pure numpy, works with both cv2/PIL) ─

def compute_histogram(
    frame: np.ndarray, bins: int = 64
) -> np.ndarray:
    """
    Compute a normalized RGB histogram for a frame.

    Args:
        frame: RGB image as numpy array (H, W, 3)
        bins: number of bins per channel

    Returns:
        Flattened normalized histogram array of shape (bins * 3,)
    """
    histograms: list[np.ndarray] = []
    for channel in range(3):
        hist, _ = np.histogram(
            frame[:, :, channel].ravel(),
            bins=bins,
            range=(0, 256),
        )
        hist = hist.astype(np.float64)
        hist = hist / (hist.sum() + 1e-8)
        histograms.append(hist)
    return np.concatenate(histograms)


def histogram_distance(h1: np.ndarray, h2: np.ndarray) -> float:
    """
    Compute Bhattacharyya distance between two histograms.
    Range: approximately 0 (identical) to 2+ (very different).
    """
    # Correlation coefficient distance
    eps: float = 1e-10
    return float(1.0 - np.sum(np.sqrt(h1 * h2 + eps)))


# ─── Frame to Base64 JPEG ─────────────────────────────────────

def frame_to_base64_jpeg(frame: np.ndarray, quality: int = 70) -> str:
    """Encode a numpy RGB frame as base64 JPEG string."""
    import base64
    from io import BytesIO

    if HAS_PIL:
        img = PILImage.fromarray(frame)
        buf = BytesIO()
        img.save(buf, format="JPEG", quality=quality)
        return base64.b64encode(buf.getvalue()).decode("utf-8")

    # Pure numpy fallback: encode as raw BMP then convert? No.
    # We need PIL — if not available, return empty
    return ""


# ─── Scene Detector ───────────────────────────────────────────

class SceneDetector:
    """
    Histogram-based shot boundary detector.

    Samples frames at regular intervals, computes histogram differences,
    and identifies scene change points where the difference exceeds a threshold.
    """

    def __init__(
        self,
        threshold: float = DEFAULT_SCENE_THRESHOLD,
        sample_interval: float = SCENE_SAMPLE_INTERVAL_SEC,
        min_duration: float = MIN_SCENE_DURATION_SEC,
    ):
        self.threshold: float = threshold
        self.sample_interval: float = sample_interval
        self.min_duration: float = min_duration

    def detect(self, video: VideoReader) -> list[SceneResult]:
        """
        Detect scene boundaries in a video.

        Args:
            video: VideoReader instance for the video file.

        Returns:
            List of SceneResult objects describing detected scenes.
        """
        if video.duration <= 0:
            return []

        # Sample frames at regular intervals
        frames: list[tuple[float, np.ndarray]] = video.read_frames_at_intervals(
            self.sample_interval
        )

        if len(frames) < 2:
            # Single scene: entire video
            scene_id: str = str(uuid.uuid4())
            thumbnail: str = ""
            if frames:
                thumbnail = frame_to_base64_jpeg(frames[0][1])
            return [
                SceneResult(
                    id=scene_id,
                    start_time=0.0,
                    end_time=video.duration,
                    thumbnail=thumbnail,
                    description="完整视频",
                    confidence=1.0,
                )
            ]

        # Compute histograms and detect boundaries
        histograms: list[np.ndarray] = [
            compute_histogram(f[1]) for f in frames
        ]
        diffs: list[float] = []
        for i in range(1, len(histograms)):
            d: float = histogram_distance(histograms[i - 1], histograms[i])
            diffs.append(d)

        # Find peaks above threshold
        peaks: list[tuple[int, float]] = []
        for i, d in enumerate(diffs):
            if d > self.threshold:
                # Check local maximum in a window
                window_start: int = max(0, i - 1)
                window_end: int = min(len(diffs), i + 2)
                is_peak: bool = all(d >= diffs[j] for j in range(window_start, window_end))
                if is_peak or d > self.threshold * 1.5:
                    peaks.append((i, d))

        # Build scene list from peaks
        scenes: list[SceneResult] = []
        scene_starts: list[float] = [0.0]
        for idx, _diff in peaks:
            boundary_time: float = frames[idx + 1][0]  # time of the frame AFTER the diff
            scene_starts.append(boundary_time)
        scene_starts.append(video.duration)

        # Filter out scenes that are too short
        for i in range(len(scene_starts) - 1):
            start: float = scene_starts[i]
            end: float = scene_starts[i + 1]
            dur: float = end - start
            if dur < self.min_duration:
                continue

            # Find the frame closest to start time for thumbnail
            closest_frame: Optional[np.ndarray] = None
            for t, f in frames:
                if t >= start:
                    closest_frame = f
                    break

            thumbnail: str = ""
            if closest_frame is not None:
                thumbnail = frame_to_base64_jpeg(closest_frame)

            # Confidence based on how clearly the boundary was detected
            confidence: float = 0.7
            if i > 0:
                # Confidence proportional to the diff at the boundary
                peak_idx: int = max(0, i - 1)
                if peak_idx < len(peaks):
                    _, boundary_diff = peaks[peak_idx]
                    confidence = min(0.99, boundary_diff / (self.threshold * 2.5))

            scenes.append(
                SceneResult(
                    id=str(uuid.uuid4()),
                    start_time=round(start, 2),
                    end_time=round(end, 2),
                    thumbnail=thumbnail,
                    description=f"场景 {len(scenes) + 1} ({dur:.1f}s)",
                    confidence=round(confidence, 2),
                )
            )

        return scenes


# ─── Quality Assessor ────────────────────────────────────────

class QualityAssessor:
    """
    Assess video quality across multiple dimensions:
    brightness, contrast, sharpness, stability, and (optional) audio.

    Uses sampled frames to compute pixel-level statistics.
    """

    def __init__(self) -> None:
        pass

    def assess(self, video: VideoReader) -> QualityResult:
        """
        Assess the quality of a video.

        Args:
            video: VideoReader instance.

        Returns:
            QualityResult with per-dimension scores.
        """
        if video.duration <= 0:
            return QualityResult(
                brightness=0.0,
                contrast=0.0,
                sharpness=0.0,
                stability=0.0,
                audio_quality=0.0,
                overall_score=0.0,
            )

        # Sample frames evenly across the video
        sample_count: int = min(30, max(5, int(video.duration / 2)))
        interval: float = video.duration / sample_count

        brightness_vals: list[float] = []
        contrast_vals: list[float] = []
        sharpness_vals: list[float] = []

        prev_frame: Optional[np.ndarray] = None
        stability_diffs: list[float] = []

        for i in range(sample_count):
            t: float = i * interval
            frame = video.read_frame_at_time(t)
            if frame is None:
                continue

            # Brightness: mean pixel value
            brightness: float = float(np.mean(frame))
            brightness_vals.append(brightness)

            # Contrast: standard deviation
            contrast: float = float(np.std(frame))
            contrast_vals.append(contrast)

            # Sharpness: Laplacian variance
            gray: np.ndarray = (
                0.299 * frame[:, :, 0].astype(np.float64)
                + 0.587 * frame[:, :, 1].astype(np.float64)
                + 0.114 * frame[:, :, 2].astype(np.float64)
            )

            # Simple Laplacian via convolution approximation
            laplacian: np.ndarray = np.zeros_like(gray)
            if gray.shape[0] > 2 and gray.shape[1] > 2:
                laplacian[1:-1, 1:-1] = (
                    gray[2:, 1:-1]
                    + gray[:-2, 1:-1]
                    + gray[1:-1, 2:]
                    + gray[1:-1, :-2]
                    - 4 * gray[1:-1, 1:-1]
                )
            sharpness: float = float(np.var(laplacian))
            sharpness_vals.append(sharpness)

            # Stability: frame-to-frame difference
            if prev_frame is not None:
                diff: float = float(np.mean(np.abs(frame.astype(np.float64) - prev_frame.astype(np.float64))))
                stability_diffs.append(diff)

            prev_frame = frame.copy()

        # Aggregate scores
        avg_brightness: float = float(np.mean(brightness_vals)) if brightness_vals else 0.0
        avg_contrast: float = float(np.mean(contrast_vals)) if contrast_vals else 0.0
        avg_sharpness: float = float(np.mean(sharpness_vals)) if sharpness_vals else 0.0

        # Stability: lower frame difference = more stable
        avg_stability_diff: float = float(np.mean(stability_diffs)) if stability_diffs else 0.0
        # Map to 0-100 score (lower diff = higher stability)
        stability_score: float = max(0.0, min(100.0, 100.0 - avg_stability_diff * 5.0))

        # Audio quality: placeholder (would need audio analysis)
        audio_score: float = 50.0  # default mid-score

        # Individual dimension scores (0-100)
        # Brightness: ideal around 128, penalty for extremes
        brightness_deviation: float = abs(avg_brightness - IDEAL_BRIGHTNESS)
        brightness_score: float = max(0.0, 100.0 - brightness_deviation * 0.8)

        # Contrast: higher is better up to a point
        contrast_score: float = min(100.0, avg_contrast * 1.5)

        # Sharpness: higher is better
        sharpness_score: float = min(100.0, avg_sharpness * 0.25)

        # Overall weighted score
        overall: float = (
            brightness_score * BRIGHTNESS_SCORE_WEIGHT
            + contrast_score * CONTRAST_SCORE_WEIGHT
            + sharpness_score * SHARPNESS_SCORE_WEIGHT
            + stability_score * STABILITY_SCORE_WEIGHT
            + audio_score * AUDIO_SCORE_WEIGHT
        )
        overall = max(0.0, min(100.0, overall))

        return QualityResult(
            brightness=round(avg_brightness, 2),
            contrast=round(avg_contrast, 2),
            sharpness=round(avg_sharpness, 2),
            stability=round(stability_score, 1),
            audio_quality=round(audio_score, 1),
            overall_score=round(overall, 0),
        )


# ─── Tag Generator ────────────────────────────────────────────

class TagGenerator:
    """
    Generate descriptive tags based on scene and quality analysis.

    Uses heuristic rules derived from scene features (brightness,
    contrast, sharpness, scene change rate) to assign content,
    style, technical, and scene tags.
    """

    def __init__(self) -> None:
        pass

    def generate(
        self,
        quality: QualityResult,
        scenes: list[SceneResult],
        duration: float,
    ) -> list[TagResult]:
        """
        Generate tags based on analysis results.

        Args:
            quality: Quality assessment result.
            scenes: Detected scene list.
            duration: Video duration in seconds.

        Returns:
            List of TagResult objects.
        """
        tags: list[TagResult] = []

        # ─── Content tags ──────────────────────────────────

        # Scene count based tag
        if len(scenes) >= 8:
            tags.append(self._make_tag("多场景", "content"))
        elif len(scenes) >= 3:
            tags.append(self._make_tag("多段落", "content"))
        elif len(scenes) <= 1:
            tags.append(self._make_tag("单场景", "content"))

        # Duration based tag
        if duration < 15:
            tags.append(self._make_tag("短视频", "content"))
        elif duration < 60:
            tags.append(self._make_tag("中等时长", "content"))
        else:
            tags.append(self._make_tag("长视频", "content"))

        # Scene change rate
        if duration > 0 and len(scenes) > 1:
            change_rate: float = len(scenes) / duration
            if change_rate > DYNAMIC_SCENE_THRESHOLD:
                tags.append(self._make_tag("快节奏", "content"))

        # ─── Style tags ────────────────────────────────────

        if quality.brightness > BRIGHT_BRIGHTNESS_THRESHOLD:
            tags.append(self._make_tag("明亮", "style"))
        elif quality.brightness < DARK_BRIGHTNESS_THRESHOLD:
            tags.append(self._make_tag("暗调", "style"))

        if quality.contrast > HIGH_CONTRAST_THRESHOLD:
            tags.append(self._make_tag("高对比", "style"))
        elif quality.contrast < 20:
            tags.append(self._make_tag("柔和", "style"))

        # ─── Technical tags ────────────────────────────────

        if quality.sharpness > HIGH_SHARPNESS_THRESHOLD:
            tags.append(self._make_tag("高清", "technical"))
        elif quality.sharpness < 50:
            tags.append(self._make_tag("低清晰度", "technical"))

        if quality.stability >= 70:
            tags.append(self._make_tag("稳定", "technical"))
        elif quality.stability < 30:
            tags.append(self._make_tag("抖动", "technical"))

        if quality.overall_score >= 80:
            tags.append(self._make_tag("高质量", "technical"))
        elif quality.overall_score < 30:
            tags.append(self._make_tag("待优化", "technical"))

        # ─── Scene tags ────────────────────────────────────

        if len(scenes) >= 3:
            tags.append(self._make_tag("转场丰富", "scene"))

        # Deduplicate by id
        seen: set[str] = set()
        unique_tags: list[TagResult] = []
        for t in tags:
            if t.id not in seen:
                seen.add(t.id)
                unique_tags.append(t)

        return unique_tags

    @staticmethod
    def _make_tag(label: str, category: str) -> TagResult:
        """Create a tag with deterministic ID."""
        tag_id: str = f"tag_{category}_{label}"
        return TagResult(id=tag_id, label=label, category=category)


# ─── Highlight Finder ─────────────────────────────────────────

class HighlightFinder:
    """
    Identify highlight moments based on scene change intensity
    and frame color richness.

    Scans through detected scenes, evaluates each based on:
    - Scene change intensity (how dramatic the cut is)
    - Color richness (variance in hue/saturation)
    - Duration appropriateness
    """

    def __init__(self) -> None:
        pass

    def find(
        self,
        video: VideoReader,
        scenes: list[SceneResult],
        quality: QualityResult,
    ) -> list[HighlightResult]:
        """
        Find highlight moments in the video.

        Args:
            video: VideoReader instance.
            scenes: Detected scenes.
            quality: Quality assessment.

        Returns:
            List of HighlightResult sorted by score descending.
        """
        if not scenes or video.duration <= 0:
            return []

        highlights: list[HighlightResult] = []

        for scene in scenes:
            dur: float = scene.end_time - scene.start_time
            mid_time: float = (scene.start_time + scene.end_time) / 2.0

            # Sample the middle frame of the scene
            mid_frame: Optional[np.ndarray] = video.read_frame_at_time(mid_time)
            if mid_frame is None:
                continue

            # Color richness: standard deviation in HSV saturation
            color_richness: float = self._compute_color_richness(mid_frame)

            # Scene change intensity: use quality as proxy
            scene_intensity: float = min(1.0, quality.contrast / 80.0)

            # Combined score
            raw_score: float = (
                scene_intensity * HIGHLIGHT_SCENE_CHANGE_WEIGHT * 100
                + color_richness * HIGHLIGHT_COLOR_WEIGHT * 100
            )

            # Duration bonus: 2-8 second clips are ideal
            if 2.0 <= dur <= 8.0:
                raw_score *= 1.15
            elif dur > 30:
                raw_score *= 0.7

            score: float = min(100.0, max(0.0, raw_score))

            if score < HIGHLIGHT_MIN_SCORE:
                continue

            # Generate reason
            reasons: list[str] = []
            if scene_intensity > 0.6:
                reasons.append("高动态场景")
            if color_richness > 0.5:
                reasons.append("色彩丰富")
            if quality.sharpness > HIGH_SHARPNESS_THRESHOLD:
                reasons.append("画面清晰")
            if not reasons:
                reasons.append("内容亮点")

            thumbnail: str = frame_to_base64_jpeg(mid_frame)

            highlights.append(
                HighlightResult(
                    id=str(uuid.uuid4()),
                    time_range=(scene.start_time, scene.end_time),
                    score=round(score, 0),
                    reason="、".join(reasons[:2]),
                    thumbnail=thumbnail,
                )
            )

        # Sort by score descending, take top N
        highlights.sort(key=lambda h: h.score, reverse=True)
        return highlights[:MAX_HIGHLIGHTS]

    @staticmethod
    def _compute_color_richness(frame: np.ndarray) -> float:
        """
        Compute color richness from frame saturation.

        Returns a value between 0 and 1.
        """
        # Convert RGB to approximate saturation
        r: np.ndarray = frame[:, :, 0].astype(np.float64)
        g: np.ndarray = frame[:, :, 1].astype(np.float64)
        b: np.ndarray = frame[:, :, 2].astype(np.float64)

        max_c: np.ndarray = np.maximum(np.maximum(r, g), b)
        min_c: np.ndarray = np.minimum(np.minimum(r, g), b)
        delta: np.ndarray = max_c - min_c

        # Saturation approximation
        sat: np.ndarray = np.zeros_like(max_c)
        mask: np.ndarray = max_c > 0
        sat[mask] = delta[mask] / (max_c[mask] + 1e-8)

        # Richness = mean saturation * diversity factor
        mean_sat: float = float(np.mean(sat))
        std_sat: float = float(np.std(sat))

        return min(1.0, mean_sat * 0.5 + std_sat * 0.5)


# ─── Analysis Engine ──────────────────────────────────────────

class AnalysisEngine:
    """
    Main analysis engine that orchestrates all sub-analyzers.

    Runs the full pipeline: scene detection → quality assessment →
    tag generation → highlight finding.

    Stores partial state and reports progress via callback.
    """

    def __init__(
        self,
        scene_threshold: float = DEFAULT_SCENE_THRESHOLD,
    ):
        self.scene_detector: SceneDetector = SceneDetector(threshold=scene_threshold)
        self.quality_assessor: QualityAssessor = QualityAssessor()
        self.tag_generator: TagGenerator = TagGenerator()
        self.highlight_finder: HighlightFinder = HighlightFinder()

    def analyze(
        self,
        material_id: str,
        file_path: str,
        progress_callback: Optional[callable] = None,
    ) -> AnalysisOutput:
        """
        Run full analysis pipeline on a single material.

        Args:
            material_id: Material identifier.
            file_path: Absolute path to the media file.
            progress_callback: Optional callback(step_name, progress_pct).

        Returns:
            Complete AnalysisOutput.
        """
        analysis_id: str = str(uuid.uuid4())
        result = AnalysisOutput(
            analysis_id=analysis_id,
            material_id=material_id,
            status="processing",
            scene_count=0,
            total_duration=0.0,
            quality_score=0,
        )

        def report_progress(
            step: str, pct: float,
        ) -> None:
            result.progress = pct
            if progress_callback:
                progress_callback(step, pct)

        video: Optional[VideoReader] = None

        try:
            # Open video
            video = VideoReader(file_path)
            result.total_duration = round(video.duration, 2)

            # Step 1: Scene detection
            report_progress("scene_detection", 10.0)
            scenes: list[SceneResult] = self.scene_detector.detect(video)
            result.scenes = scenes
            result.scene_count = len(scenes)
            report_progress("scene_detection", 30.0)

            # Step 2: Quality assessment
            report_progress("quality_analysis", 35.0)
            quality: QualityResult = self.quality_assessor.assess(video)
            result.quality_report = quality
            result.quality_score = int(quality.overall_score)
            report_progress("quality_analysis", 55.0)

            # Step 3: Tag generation
            report_progress("tag_generation", 60.0)
            tags: list[TagResult] = self.tag_generator.generate(
                quality, scenes, video.duration
            )
            result.tags = tags
            report_progress("tag_generation", 75.0)

            # Step 4: Highlight finding
            report_progress("highlight_detection", 80.0)
            highlights: list[HighlightResult] = self.highlight_finder.find(
                video, scenes, quality
            )
            result.highlights = highlights
            report_progress("highlight_detection", 95.0)

            result.status = "done"
            result.progress = 100.0
            result.analyzed_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

        except Exception as e:
            result.status = "error"
            result.error_message = str(e)
            result.progress = 100.0
        finally:
            if video is not None:
                video.close()

        return result


# ─── Global engine instance ───────────────────────────────────

_engine: Optional[AnalysisEngine] = None


def get_engine(scene_threshold: float = DEFAULT_SCENE_THRESHOLD) -> AnalysisEngine:
    """Get or create the global analysis engine instance."""
    global _engine
    if _engine is None:
        _engine = AnalysisEngine(scene_threshold=scene_threshold)
    return _engine
