"""
Materials API routes.

Endpoints for material validation, metadata probing, and thumbnail generation.
All responses follow the unified format: { code: int, message: str, data: object | null }

Endpoints:
    POST /api/materials/validate     — Validate a file's format and readability
    POST /api/materials/probe        — Extract video/image metadata using ffprobe
    POST /api/materials/upload       — Upload file(s) from browser (browser dev mode)
    GET  /api/materials/thumbnail/{material_id} — Generate thumbnail for a material
"""

import os
import shutil
import subprocess
import base64
import tempfile
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Query, HTTPException, UploadFile, File

from config import (
    FFPROBE_EXECUTABLE,
    FFMPEG_EXECUTABLE,
    MAX_MATERIAL_FILE_SIZE_MB,
    TEMP_DIR,
    ErrorCode,
)

router = APIRouter(prefix="/api/materials", tags=["materials"])

# ─── Supported extensions ────────────────────────────────

VIDEO_EXTENSIONS: set[str] = {
    '.mp4', '.mov', '.avi', '.webm', '.mkv', '.m4v', '.flv', '.wmv',
}

IMAGE_EXTENSIONS: set[str] = {
    '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff',
}

ALL_SUPPORTED_EXTENSIONS: set[str] = VIDEO_EXTENSIONS | IMAGE_EXTENSIONS

# Maximum file size in bytes (convert from MB)
MAX_FILE_SIZE_BYTES: int = MAX_MATERIAL_FILE_SIZE_MB * 1024 * 1024


def _get_extension(file_path: str) -> str:
    """Get lowercased file extension with dot."""
    return Path(file_path).suffix.lower()


def _is_video(ext: str) -> bool:
    """Check if extension is a supported video format."""
    return ext in VIDEO_EXTENSIONS


def _is_image(ext: str) -> bool:
    """Check if extension is a supported image format."""
    return ext in IMAGE_EXTENSIONS


def _build_success(data=None, message: str = "success") -> dict:
    """Build a success response."""
    return {"code": 0, "message": message, "data": data}


def _build_error(code: int, message: str, data=None) -> dict:
    """Build an error response."""
    return {"code": code, "message": message, "data": data}


# ─── POST /validate ─────────────────────────────────────

@router.post("/validate")
async def validate_material(request: dict):
    """
    Validate a material file.

    Checks:
    - File exists and is readable
    - File extension is supported
    - File size is within limits

    Request body: { "file_path": "/absolute/path/to/file.mp4" }

    Returns:
        { code: 0, message: "success", data: { valid: bool, type: "video"|"image", ... } }
    """
    file_path: Optional[str] = request.get("file_path")
    if not file_path:
        return _build_error(40001, "缺少 file_path 参数")

    # Check existence
    if not os.path.exists(file_path):
        return _build_success({
            "valid": False,
            "reason": "文件不存在",
            "file_path": file_path,
        })

    # Check readability
    if not os.access(file_path, os.R_OK):
        return _build_success({
            "valid": False,
            "reason": "文件不可读",
            "file_path": file_path,
        })

    # Check extension
    ext = _get_extension(file_path)
    if ext not in ALL_SUPPORTED_EXTENSIONS:
        return _build_success({
            "valid": False,
            "reason": f"不支持的格式：{ext}",
            "file_path": file_path,
        })

    # Check file size
    try:
        file_size: int = os.path.getsize(file_path)
    except OSError:
        return _build_success({
            "valid": False,
            "reason": "无法获取文件大小",
            "file_path": file_path,
        })

    if file_size > MAX_FILE_SIZE_BYTES:
        max_gb: float = MAX_MATERIAL_FILE_SIZE_MB / 1024
        return _build_success({
            "valid": False,
            "reason": f"文件超过大小限制 ({max_gb:.0f} GB)",
            "file_path": file_path,
            "file_size": file_size,
        })

    material_type: str = "video" if _is_video(ext) else "image"

    return _build_success({
        "valid": True,
        "type": material_type,
        "file_path": file_path,
        "file_size": file_size,
        "extension": ext,
    })


# ─── POST /probe ────────────────────────────────────────

@router.post("/probe")
async def probe_material(request: dict):
    """
    Probe a media file for metadata using ffprobe.

    For videos: extracts duration, fps, codec, bitrate, width, height.
    For images: extracts width, height, format.

    Request body: { "file_path": "/absolute/path/to/file.mp4" }

    Returns:
        { code: 0, message: "success", data: { ... metadata ... } }
    """
    file_path: Optional[str] = request.get("file_path")
    if not file_path:
        return _build_error(40001, "缺少 file_path 参数")

    if not os.path.exists(file_path):
        return _build_error(40004, f"文件不存在: {file_path}")

    ext = _get_extension(file_path)

    try:
        file_size: int = os.path.getsize(file_path)
    except OSError as e:
        return _build_error(ErrorCode.INTERNAL_ERROR, f"文件读取失败: {e}")

    if _is_video(ext):
        return _probe_video(file_path, file_size)
    elif _is_image(ext):
        return _probe_image(file_path, file_size, ext)
    else:
        return _build_error(40001, f"不支持的格式: {ext}")


def _probe_video(file_path: str, file_size: int) -> dict:
    """
    Extract video metadata using ffprobe.
    """
    # Check if ffprobe exists
    if not os.path.exists(FFPROBE_EXECUTABLE):
        # Try system ffprobe
        ffprobe_path: str = "ffprobe"
    else:
        ffprobe_path: str = FFPROBE_EXECUTABLE

    cmd: list[str] = [
        ffprobe_path,
        "-v", "quiet",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        file_path,
    ]

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except FileNotFoundError:
        return _build_error(
            ErrorCode.FFMPEG_NOT_FOUND,
            "ffprobe 未找到，请确保 FFmpeg 已安装",
        )
    except subprocess.TimeoutExpired:
        return _build_error(
            ErrorCode.INTERNAL_ERROR,
            "ffprobe 执行超时（30s）",
        )

    if result.returncode != 0:
        return _build_error(
            ErrorCode.FFMPEG_FAILED,
            f"ffprobe 执行失败: {result.stderr[:500] if result.stderr else 'unknown error'}",
        )

    import json
    try:
        probe_data: dict = json.loads(result.stdout)
    except json.JSONDecodeError:
        return _build_error(
            ErrorCode.INTERNAL_ERROR,
            "ffprobe 输出解析失败",
        )

    streams: list = probe_data.get("streams", [])
    fmt: dict = probe_data.get("format", {})

    # Find first video stream
    video_stream: Optional[dict] = None
    for stream in streams:
        if stream.get("codec_type") == "video":
            video_stream = stream
            break

    if not video_stream:
        return _build_error(
            ErrorCode.INTERNAL_ERROR,
            "未找到视频流",
        )

    # Extract video metadata
    duration_seconds: float = float(fmt.get("duration", 0))
    width: int = video_stream.get("width", 0)
    height: int = video_stream.get("height", 0)

    # Parse fps from r_frame_rate (format: "30000/1001")
    fps: float = 0.0
    fps_str: str = video_stream.get("r_frame_rate", "0/1")
    try:
        num, den = fps_str.split("/")
        if int(den) != 0:
            fps = float(num) / float(den)
    except (ValueError, ZeroDivisionError):
        fps = 0.0

    codec: str = video_stream.get("codec_name", "unknown")
    bitrate: int = int(fmt.get("bit_rate", 0))

    return _build_success({
        "duration_seconds": round(duration_seconds, 2),
        "fps": round(fps, 2),
        "codec": codec,
        "bitrate": bitrate,
        "width": width,
        "height": height,
        "file_size": file_size,
        "type": "video",
    })


def _probe_image(file_path: str, file_size: int, ext: str) -> dict:
    """
    Extract image metadata.
    Uses ffprobe as primary method, with PIL fallback.
    """
    width: int = 0
    height: int = 0

    # Try ffprobe first
    if os.path.exists(FFPROBE_EXECUTABLE):
        ffprobe_path: str = FFPROBE_EXECUTABLE
    else:
        ffprobe_path = "ffprobe"

    try:
        result = subprocess.run(
            [ffprobe_path, "-v", "quiet", "-print_format", "json",
             "-show_streams", file_path],
            capture_output=True,
            text=True,
            timeout=15,
        )

        if result.returncode == 0:
            import json
            probe_data = json.loads(result.stdout)
            streams = probe_data.get("streams", [])
            for stream in streams:
                if stream.get("codec_type") == "video":
                    width = stream.get("width", 0)
                    height = stream.get("height", 0)
                    break
    except (FileNotFoundError, subprocess.TimeoutExpired, json.JSONDecodeError):
        pass

    # Fallback: try to use PIL
    if width == 0 or height == 0:
        try:
            from PIL import Image
            with Image.open(file_path) as img:
                width, height = img.size
        except ImportError:
            pass
        except Exception:
            # If everything fails, return zeros
            pass

    # Normalize format name
    fmt_name: str = ext.lstrip(".").lower()
    if fmt_name == "jpg":
        fmt_name = "jpeg"

    return _build_success({
        "duration_seconds": 0,
        "fps": 0,
        "codec": "",
        "bitrate": 0,
        "width": width,
        "height": height,
        "file_size": file_size,
        "type": "image",
        "format": fmt_name,
    })


# ─── POST /upload ─────────────────────────────────────
# Browser dev mode: upload files to temp directory for validation/probing

@router.post("/upload")
async def upload_material(file: UploadFile = File(...)):
    """
    Upload a material file from browser (dev mode).
    
    Saves to TEMP_DIR, validates extension, probes metadata with ffprobe.
    Returns the material info including the saved temp file path.
    """
    from config import TEMP_DIR

    # Validate filename
    if not file.filename:
        return _build_error(40001, "文件名为空")

    ext = _get_extension(file.filename)
    if ext not in ALL_SUPPORTED_EXTENSIONS:
        return _build_error(40001, f"不支持的格式：{ext}")

    # Ensure temp upload dir exists
    upload_dir = Path(TEMP_DIR) / "uploads"
    upload_dir.mkdir(parents=True, exist_ok=True)

    safe_name = file.filename.replace("\\", "_").replace("/", "_")
    temp_path = upload_dir / safe_name
    try:
        with open(temp_path, "wb") as f:
            shutil.copyfileobj(file.file, f)
    except Exception as e:
        return _build_error(ErrorCode.INTERNAL_ERROR, f"文件保存失败: {e}")

    file_path_str = str(temp_path)
    file_size = os.path.getsize(file_path_str)

    if file_size > MAX_FILE_SIZE_BYTES:
        try:
            os.unlink(temp_path)
        except OSError:
            pass
        return _build_error(40007, f"文件超过大小限制")

    material_type = "video" if _is_video(ext) else "image"

    # Probe metadata (non-fatal if probe fails)
    probe_data = {}
    if material_type == "video":
        probe_result = _probe_video(file_path_str, file_size)
    else:
        probe_result = _probe_image(file_path_str, file_size, ext)

    if probe_result["code"] == 0 and probe_result.get("data"):
        probe_data = probe_result["data"]

    return _build_success({
        "valid": True,
        "type": material_type,
        "file_path": file_path_str,
        "file_name": file.filename,
        "file_size": file_size,
        "duration_seconds": probe_data.get("duration_seconds", 0),
        "width": probe_data.get("width", 0),
        "height": probe_data.get("height", 0),
        "fps": probe_data.get("fps", 0),
        "codec": probe_data.get("codec", "unknown"),
        "bitrate": probe_data.get("bitrate", 0),
        "format": probe_data.get("format", ""),
    })


# ─── GET /thumbnail/{material_id} ───────────────────────

@router.get("/thumbnail/{material_id}")
async def get_thumbnail(
    material_id: str,
    file_path: str = Query(..., description="Absolute file path of the material"),
):
    """
    Generate a thumbnail for the given material.

    For videos: extracts a frame at 1 second (or 10% of duration).
    For images: resizes to a max dimension of 320px.

    Returns the thumbnail as a base64-encoded JPEG string.

    Query params:
        file_path: Absolute path to the media file

    Returns:
        { code: 0, message: "success", data: { thumbnail: "<base64>" } }
    """
    if not os.path.exists(file_path):
        return _build_error(ErrorCode.INTERNAL_ERROR, f"文件不存在: {file_path}")

    ext = _get_extension(file_path)

    # Check if ffmpeg exists
    if os.path.exists(FFMPEG_EXECUTABLE):
        ffmpeg_path: str = FFMPEG_EXECUTABLE
    else:
        ffmpeg_path = "ffmpeg"

    # Create a temporary file for the thumbnail
    tmp_suffix: str = ".jpg"
    tmp_fd, tmp_path = tempfile.mkstemp(suffix=tmp_suffix)
    os.close(tmp_fd)

    try:
        if _is_video(ext):
            # Extract frame at 1 second
            # Use fast seek (-ss before -i) for performance
            cmd: list[str] = [
                ffmpeg_path,
                "-ss", "1",
                "-i", file_path,
                "-vframes", "1",
                "-q:v", "5",
                "-vf", "scale=320:-1",
                "-y",
                tmp_path,
            ]
        elif _is_image(ext):
            # Resize image to max 320px wide
            cmd = [
                ffmpeg_path,
                "-i", file_path,
                "-vf", "scale=320:-1",
                "-q:v", "5",
                "-y",
                tmp_path,
            ]
        else:
            return _build_error(40001, f"不支持的格式: {ext}")

        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=30,
            )
        except FileNotFoundError:
            return _build_error(
                ErrorCode.FFMPEG_NOT_FOUND,
                "ffmpeg 未找到，请确保 FFmpeg 已安装",
            )
        except subprocess.TimeoutExpired:
            return _build_error(
                ErrorCode.INTERNAL_ERROR,
                "缩略图生成超时（30s）",
            )

        if result.returncode != 0 or not os.path.exists(tmp_path) or os.path.getsize(tmp_path) == 0:
            return _build_error(
                ErrorCode.FFMPEG_FAILED,
                f"缩略图生成失败: {result.stderr[:300] if result.stderr else 'unknown error'}",
            )

        # Read thumbnail and encode as base64
        with open(tmp_path, "rb") as f:
            thumbnail_bytes: bytes = f.read()

        thumbnail_b64: str = base64.b64encode(thumbnail_bytes).decode("utf-8")

        return _build_success({
            "thumbnail": thumbnail_b64,
            "material_id": material_id,
        })

    finally:
        # Clean up temp file
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
