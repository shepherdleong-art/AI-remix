"""
全局配置模块

提供 Python 后端的全局配置参数，包括：
- 端口范围
- CORS 允许的来源
- 路径默认值
- 渲染参数默认值
"""

import os
import sys
import platform
import shutil
import subprocess
from pathlib import Path


# ─── 应用元信息 ────────────────────────────────────────────

APP_TITLE: str = "短视频智能混剪工具 - Backend"
APP_VERSION: str = "1.0.0"
APP_DESCRIPTION: str = "基于AI的短视频自动化剪辑平台后端服务"


# ─── 端口配置 ──────────────────────────────────────────────

PORT_RANGE_START: int = int(os.environ.get("MASHUP_PORT_START", "18000"))
PORT_RANGE_END: int = int(os.environ.get("MASHUP_PORT_END", "18999"))


# ─── CORS 配置 ─────────────────────────────────────────────

CORS_ALLOWED_ORIGINS: list[str] = [
    # Development mode: allow all origins
    "*",
]


# ─── 路径配置 ──────────────────────────────────────────────

def _get_base_dir() -> Path:
    """获取应用基础目录（开发环境为 backend/，打包后为可执行文件所在目录）。"""
    if getattr(sys, 'frozen', False):
        # PyInstaller 打包后的路径
        return Path(sys.executable).parent
    else:
        # 开发环境路径: backend/
        return Path(__file__).parent


BASE_DIR: Path = _get_base_dir()


def _get_appdata_dir() -> Path:
    """获取用户数据目录 (AppData)。"""
    system = platform.system()
    if system == "Windows":
        base = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming"))
    elif system == "Darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share"))
    return base / "short-video-mashup-tool"


APPDATA_DIR: Path = _get_appdata_dir()
TEMPLATES_DIR: Path = APPDATA_DIR / "templates"
PRESETS_DIR: Path = BASE_DIR.parent / "resources" / "presets"

# 确保必要目录存在
APPDATA_DIR.mkdir(parents=True, exist_ok=True)
TEMPLATES_DIR.mkdir(parents=True, exist_ok=True)


# ─── 临时文件配置 ──────────────────────────────────────────

TEMP_DIR: Path = Path(os.environ.get("TEMP", os.environ.get("TMP", "/tmp"))) / "short-video-mashup-temp"

# 确保临时目录存在
TEMP_DIR.mkdir(parents=True, exist_ok=True)


# ─── FFmpeg 配置 ───────────────────────────────────────────

def _get_ffmpeg_dir() -> Path:
    """获取内置 FFmpeg 路径。"""
    if getattr(sys, 'frozen', False):
        return Path(sys.executable).parent / "resources" / "ffmpeg"
    return BASE_DIR.parent / "resources" / "ffmpeg"


FFMPEG_DIR: Path = _get_ffmpeg_dir()


def _node_platform_arch() -> tuple[str, str]:
    """Return the platform/arch folder names used by ffprobe-static."""
    system = platform.system()
    machine = platform.machine().lower()
    arch = "arm64" if machine in {"arm64", "aarch64"} else "x64"

    if system == "Darwin":
        return "darwin", arch
    if system == "Windows":
        return "win32", arch
    return "linux", arch


def _resolve_executable(env_var: str, bundled: Path, node_module: Path, command: str) -> str:
    """优先使用环境变量/项目本地二进制，最后回退到系统 PATH。"""
    env_path = os.environ.get(env_var, "")
    candidates = [
        Path(env_path) if env_path else None,
        bundled,
        node_module,
    ]

    for candidate in candidates:
        if candidate and candidate.is_file():
            if platform.system() != "Windows":
                try:
                    candidate.chmod(candidate.stat().st_mode | 0o755)
                except OSError:
                    pass
            candidate_path = str(candidate)
            if _executable_works(candidate_path):
                return candidate_path

    system_path = shutil.which(command)
    if system_path and _executable_works(system_path):
        return system_path

    return command


def _executable_works(executable: str) -> bool:
    try:
        result = subprocess.run(
            [executable, "-version"],
            capture_output=True,
            timeout=5,
        )
        return result.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


_node_platform, _node_arch = _node_platform_arch()
_bin_suffix = ".exe" if platform.system() == "Windows" else ""
_node_modules_dir = BASE_DIR.parent / "node_modules"

FFMPEG_EXECUTABLE: str = _resolve_executable(
    "FFMPEG_PATH",
    FFMPEG_DIR / f"ffmpeg{_bin_suffix}",
    _node_modules_dir / "ffmpeg-static" / f"ffmpeg{_bin_suffix}",
    f"ffmpeg{_bin_suffix}",
)

FFPROBE_EXECUTABLE: str = _resolve_executable(
    "FFPROBE_PATH",
    FFMPEG_DIR / f"ffprobe{_bin_suffix}",
    _node_modules_dir / "ffprobe-static" / "bin" / _node_platform / _node_arch / f"ffprobe{_bin_suffix}",
    f"ffprobe{_bin_suffix}",
)


# ─── 渲染参数默认值 ────────────────────────────────────────

RENDER_DEFAULTS: dict = {
    "fps": 30,
    "width": 1920,
    "height": 1080,
    "video_codec": "libx264",
    "audio_codec": "aac",
    "video_bitrate": "5M",
    "audio_bitrate": "192k",
    "crf": 23,
    "preset": "medium",
    "output_format": "mp4",
}

# 并行渲染数（自动 = CPU 核心数 - 1，至少为 1）
# NOTE: Currently RenderQueue uses a single serial worker. This config value is reserved
# for future parallel rendering support. Do not remove — it documents the intended limit.
PARALLEL_RENDER_WORKERS: int = max(1, os.cpu_count() - 1 if os.cpu_count() else 2)


# ─── 素材限制 ──────────────────────────────────────────────

MAX_MATERIALS_COUNT: int = 500
MAX_MATERIAL_FILE_SIZE_MB: int = 2048  # 2GB


# ─── 分析配置 ──────────────────────────────────────────────

# 场景检测直方图差异阈值 (0-100+), 越低越敏感
ANALYSIS_SCENE_THRESHOLD: float = float(
    os.environ.get("MASHUP_SCENE_THRESHOLD", "30.0")
)

# 场景检测采样间隔 (秒)
ANALYSIS_SAMPLE_INTERVAL_SEC: float = float(
    os.environ.get("MASHUP_SAMPLE_INTERVAL", "0.5")
)

# 最小场景时长 (秒)
ANALYSIS_MIN_SCENE_DURATION_SEC: float = float(
    os.environ.get("MASHUP_MIN_SCENE_DURATION", "0.5")
)

# 分析临时文件目录 (存储中间帧)
ANALYSIS_TEMP_DIR: str = str(TEMP_DIR / "analysis")

# 确保分析临时目录存在
Path(ANALYSIS_TEMP_DIR).mkdir(parents=True, exist_ok=True)

# 最大并发分析任务数
ANALYSIS_MAX_CONCURRENT: int = int(
    os.environ.get("MASHUP_ANALYSIS_CONCURRENT", "3")
)


# ─── AI 服务配置 ──────────────────────────────────────────

# AI API endpoint (OpenAI-compatible, e.g. api.v3.cm)
AI_API_BASE_URL: str = os.environ.get(
    "AI_API_BASE", "https://api.v3.cm/v1"
)
AI_API_KEY: str = os.environ.get(
    "AI_API_KEY", ""
)

# TTS model
AI_TTS_MODEL: str = os.environ.get(
    "AI_TTS_MODEL", "qwen3-tts-flash"
)
# Vision model for video analysis
AI_VISION_MODEL: str = os.environ.get(
    "AI_VISION_MODEL", "gpt-5.5"
)
# Text model for script analysis
AI_TEXT_MODEL: str = os.environ.get(
    "AI_TEXT_MODEL", "gpt-5.5"
)

# Scene detection
AI_SCENE_THRESHOLD: float = float(
    os.environ.get("AI_SCENE_THRESHOLD", "20.0")
)
AI_MIN_SCENE_DURATION: float = float(
    os.environ.get("AI_MIN_SCENE_DURATION", "0.3")
)


# ─── 错误码定义 ────────────────────────────────────────────

class ErrorCode:
    """统一错误码。"""
    SUCCESS: int = 0

    # 素材相关 (40001-40010)
    NUMBER_NOT_CONSECUTIVE: int = 40001
    NUMBER_DUPLICATE: int = 40002
    NUMBER_CONFLICT: int = 40003
    FOLDER_NOT_FOUND: int = 40004
    MISSING_REQUIRED_MATERIAL: int = 40005
    TEMPLATE_INVALID: int = 40006
    EXCEED_MAX_MATERIALS: int = 40007

    # 渲染相关 (40008-40020)
    FFMPEG_FAILED: int = 40008
    CANCEL_FAILED: int = 40009
    EXPORT_PATH_INVALID: int = 40010

    # 服务内部错误 (50001-50010)
    INTERNAL_ERROR: int = 50001
    FFMPEG_NOT_FOUND: int = 50002
