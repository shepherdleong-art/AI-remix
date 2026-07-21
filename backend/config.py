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
import json
import platform
import shutil
import subprocess
from pathlib import Path


# ─── Windows 子进程窗口抑制 ─────────────────────────────────
# 所有 ffmpeg/ffprobe 等后端子进程调用都不应弹出 cmd 控制台窗口。
# 在 subprocess.Popen 层统一注入 CREATE_NO_WINDOW，避免前端批量界面
# 同时加载大量缩略图时触发「疯狂弹窗」问题。
if sys.platform == "win32":
    _orig_popen_init = subprocess.Popen.__init__

    def _popen_init_no_window(self, *args, **kwargs):
        creationflags = kwargs.pop("creationflags", 0)
        creationflags |= subprocess.CREATE_NO_WINDOW
        # L1 (④ CPU 优化)：后台 ffmpeg/ffprobe 子进程一律低优先级，
        # 渲染进程（NORMAL）在 OS 调度器里天然优先 → 即便 CPU 读数 100%，UI 依然跟手。
        creationflags |= subprocess.BELOW_NORMAL_PRIORITY_CLASS
        kwargs["creationflags"] = creationflags
        return _orig_popen_init(self, *args, **kwargs)

    subprocess.Popen.__init__ = _popen_init_no_window


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

# ─── 开发模式端口文件 ─────────────────────────────────────
# 浏览器开发模式下，后端将实际使用的端口写入此文件。
# Vite dev server 中间件读取此文件并返回给前端，
# 使前端能正确连接到动态协商的端口（而非硬编码 18000）。
# 仅在开发模式下使用；Electron 模式通过 IPC 获取端口，不依赖此文件。
DEV_PORT_FILE: Path = BASE_DIR / '.dev-port'


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

# 背景音乐库目录（本地化，用户可手动放置或通过导入上传）
MUSIC_DIR: Path = Path(os.environ.get("MASHUP_MUSIC_DIR", str(Path(__file__).resolve().parent.parent / "music")))
MUSIC_DIR.mkdir(parents=True, exist_ok=True)


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


# ─── TTS 多服务商配置 ──────────────────────────────────────
# provider: "qwen" (默认，兼容现有 api.v3.cm 链路) | "doubao" (字节火山引擎)
TTS_PROVIDER: str = os.environ.get("TTS_PROVIDER", "qwen")

# 豆包（火山引擎）双向流式 TTS
DOUBAO_WSS_URL: str = os.environ.get(
    "DOUBAO_WSS_URL", "wss://openspeech.bytedance.com/api/v3/tts/bidirection"
)
# ⚠️ 资源 ID（X-Api-Resource-Id）：豆包 2.0 全部音色共用 seed-tts-2.0，
# 1.0 经典版用 volc.service_type.10029。ai_service.text_to_speech 会按音色查表发送正确的 header。
DOUBAO_RESOURCE_ID: str = os.environ.get("DOUBAO_RESOURCE_ID", "seed-tts-2.0")
DOUBAO_MODEL: str = os.environ.get("DOUBAO_MODEL", "seed-tts-2.0-standard")
# 默认音色：豆包 2.0 池中已用真实 key 验证可正常合成的 Uranus，置于列表首位作为默认。
DOUBAO_DEFAULT_VOICE: str = os.environ.get("DOUBAO_DEFAULT_VOICE", "zh_female_vv_uranus_bigtts")

# 豆包（火山引擎）TTS WebSocket 鉴权支持两种模型（官方 bidirectional 文档）：
#   ① 新版控制台（推荐）：单个 API Key，走 X-Api-Key 头，从「控制台 > API Key 管理」获取。
#   ② 旧版控制台：配对凭证 X-Api-App-Key（App Key）+ X-Api-Access-Key（Access Token，有有效期）。
# 实测：用户此前给的均为应用级 AppKey，非「API Key 管理」里的 API Key，故单 key 与配对均失败；
#       代码两种都支持——优先用 api_key（X-Api-Key），否则退回 app_key/access_key 配对。
DOUBAO_API_KEY: str = os.environ.get("DOUBAO_API_KEY", "")
DOUBAO_APP_KEY: str = os.environ.get("DOUBAO_APP_KEY", "")
DOUBAO_ACCESS_KEY: str = os.environ.get("DOUBAO_ACCESS_KEY", "")

# 豆包音色列表（来源：火山引擎官方「豆包语音合成模型2.0 音色列表」文档）。
# 全部为 2.0 大模型音色（统一资源池 seed-tts-2.0），已用真实 key 验证全部可用。
# 可用环境变量 DOUBAO_VOICES 覆盖为 JSON 数组 [{id,name,gender,resource_id}]。
_DOUBAO_VOICES_ENV = os.environ.get("DOUBAO_VOICES", "")
if _DOUBAO_VOICES_ENV:
    try:
        DOUBAO_VOICES: list = json.loads(_DOUBAO_VOICES_ENV)
    except Exception:
        DOUBAO_VOICES = []
else:
    DOUBAO_VOICES = [
        # ── 豆包语音合成模型 2.0 全部音色（统一资源池 seed-tts-2.0，已验证全部可用）──
        {"id": "zh_female_vv_uranus_bigtts", "name": "Uranus 大语音 / Vivi 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        # 通用场景
        {"id": "zh_female_xiaohe_uranus_bigtts", "name": "小何 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "zh_male_m191_uranus_bigtts", "name": "云舟 2.0", "gender": "male", "resource_id": "seed-tts-2.0"},
        {"id": "zh_male_taocheng_uranus_bigtts", "name": "小天 2.0", "gender": "male", "resource_id": "seed-tts-2.0"},
        {"id": "zh_male_liufei_uranus_bigtts", "name": "刘飞 2.0", "gender": "male", "resource_id": "seed-tts-2.0"},
        {"id": "zh_female_sophie_uranus_bigtts", "name": "魅力苏菲 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "zh_female_qingxinnvsheng_uranus_bigtts", "name": "清新女声 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "zh_female_cancan_uranus_bigtts", "name": "知性灿灿 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "zh_female_sajiaoxuemei_uranus_bigtts", "name": "撒娇学妹 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "zh_female_tianmeixiaoyuan_uranus_bigtts", "name": "甜美小源 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "zh_female_tianmeitaozi_uranus_bigtts", "name": "甜美桃子 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "zh_female_shuangkuaisisi_uranus_bigtts", "name": "爽快思思 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "zh_female_peiqi_uranus_bigtts", "name": "佩奇猪 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "zh_female_linjianvhai_uranus_bigtts", "name": "邻家女孩 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "zh_male_shaonianzixin_uranus_bigtts", "name": "少年梓辛 2.0", "gender": "male", "resource_id": "seed-tts-2.0"},
        {"id": "zh_male_sunwukong_uranus_bigtts", "name": "猴哥 2.0", "gender": "male", "resource_id": "seed-tts-2.0"},
        {"id": "zh_female_yingyujiaoxue_uranus_bigtts", "name": "Tina老师 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "zh_female_kefunvsheng_uranus_bigtts", "name": "暖阳女声 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "zh_female_xiaoxue_uranus_bigtts", "name": "儿童绘本 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "zh_male_dayi_uranus_bigtts", "name": "大壹 2.0", "gender": "male", "resource_id": "seed-tts-2.0"},
        {"id": "zh_female_mizai_uranus_bigtts", "name": "黑猫侦探社咪仔 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "zh_female_jitangnv_uranus_bigtts", "name": "鸡汤女 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "zh_female_meilinvyou_uranus_bigtts", "name": "魅力女友 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "zh_female_liuchangnv_uranus_bigtts", "name": "流畅女声 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "zh_male_ruyayichen_uranus_bigtts", "name": "儒雅逸辰 2.0", "gender": "male", "resource_id": "seed-tts-2.0"},
        {"id": "en_male_tim_uranus_bigtts", "name": "Tim", "gender": "male", "resource_id": "seed-tts-2.0"},
        {"id": "en_female_dacey_uranus_bigtts", "name": "Dacey", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "en_female_stokie_uranus_bigtts", "name": "Stokie", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "zh_female_wenroumama_uranus_bigtts", "name": "温柔妈妈 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "zh_male_jieshuoxiaoming_uranus_bigtts", "name": "解说小明 2.0", "gender": "male", "resource_id": "seed-tts-2.0"},
        {"id": "zh_female_tvbnv_uranus_bigtts", "name": "TVB女声 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "zh_male_yizhipiannan_uranus_bigtts", "name": "译制片男 2.0", "gender": "male", "resource_id": "seed-tts-2.0"},
        {"id": "zh_female_qiaopinv_uranus_bigtts", "name": "俏皮女声 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "zh_female_zhishuaiyingzi_uranus_bigtts", "name": "直率英子 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "zh_male_linjiananhai_uranus_bigtts", "name": "邻家男孩 2.0", "gender": "male", "resource_id": "seed-tts-2.0"},
        {"id": "zh_male_silang_uranus_bigtts", "name": "四郎 2.0", "gender": "male", "resource_id": "seed-tts-2.0"},
        {"id": "zh_male_ruyaqingnian_uranus_bigtts", "name": "儒雅青年 2.0", "gender": "male", "resource_id": "seed-tts-2.0"},
        {"id": "zh_male_qingcang_uranus_bigtts", "name": "擎苍 2.0", "gender": "male", "resource_id": "seed-tts-2.0"},
        {"id": "zh_male_xionger_uranus_bigtts", "name": "熊二 2.0", "gender": "male", "resource_id": "seed-tts-2.0"},
        {"id": "zh_female_yingtaowanzi_uranus_bigtts", "name": "樱桃丸子 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "zh_male_wennuanahu_uranus_bigtts", "name": "温暖阿虎 2.0", "gender": "male", "resource_id": "seed-tts-2.0"},
        {"id": "zh_male_naiqimengwa_uranus_bigtts", "name": "奶气萌娃 2.0", "gender": "male", "resource_id": "seed-tts-2.0"},
        {"id": "zh_female_popo_uranus_bigtts", "name": "婆婆 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "zh_female_gaolengyujie_uranus_bigtts", "name": "高冷御姐 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "zh_male_aojiaobazong_uranus_bigtts", "name": "傲娇霸总 2.0", "gender": "male", "resource_id": "seed-tts-2.0"},
        {"id": "zh_male_lanyinmianbao_uranus_bigtts", "name": "懒音绵宝 2.0", "gender": "male", "resource_id": "seed-tts-2.0"},
        {"id": "zh_male_fanjuanqingnian_uranus_bigtts", "name": "反卷青年 2.0", "gender": "male", "resource_id": "seed-tts-2.0"},
        {"id": "zh_female_wenroushunv_uranus_bigtts", "name": "温柔淑女 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "zh_female_gufengshaoyu_uranus_bigtts", "name": "古风少御 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "zh_male_huolixiaoge_uranus_bigtts", "name": "活力小哥 2.0", "gender": "male", "resource_id": "seed-tts-2.0"},
        {"id": "zh_male_baqiqingshu_uranus_bigtts", "name": "霸气青叔 2.0", "gender": "male", "resource_id": "seed-tts-2.0"},
        {"id": "zh_male_xuanyijieshuo_uranus_bigtts", "name": "悬疑解说 2.0", "gender": "male", "resource_id": "seed-tts-2.0"},
        {"id": "zh_female_mengyatou_uranus_bigtts", "name": "萌丫头 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "zh_female_tiexinnvsheng_uranus_bigtts", "name": "贴心女声 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "zh_female_jitangmei_uranus_bigtts", "name": "鸡汤妹妹 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "zh_male_cixingjieshuonan_uranus_bigtts", "name": "磁性解说男声 2.0", "gender": "male", "resource_id": "seed-tts-2.0"},
        {"id": "zh_male_liangsangmengzai_uranus_bigtts", "name": "亮嗓萌仔 2.0", "gender": "male", "resource_id": "seed-tts-2.0"},
        {"id": "zh_female_kailangjiejie_uranus_bigtts", "name": "开朗姐姐 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "zh_male_gaolengchenwen_uranus_bigtts", "name": "高冷沉稳 2.0", "gender": "male", "resource_id": "seed-tts-2.0"},
        {"id": "zh_male_lubanqihao_uranus_bigtts", "name": "鲁班七号 2.0", "gender": "male", "resource_id": "seed-tts-2.0"},
        {"id": "zh_female_jiaochuannv_uranus_bigtts", "name": "娇喘女声 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "zh_female_linxiao_uranus_bigtts", "name": "林潇 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "zh_female_lingling_uranus_bigtts", "name": "玲玲姐姐 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "zh_female_chunribu_uranus_bigtts", "name": "春日部姐姐 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "zh_male_tangseng_uranus_bigtts", "name": "唐僧 2.0", "gender": "male", "resource_id": "seed-tts-2.0"},
        {"id": "zh_male_zhuangzhou_uranus_bigtts", "name": "庄周 2.0", "gender": "male", "resource_id": "seed-tts-2.0"},
        {"id": "zh_male_kailangdidi_uranus_bigtts", "name": "开朗弟弟 2.0", "gender": "male", "resource_id": "seed-tts-2.0"},
        {"id": "zh_male_zhubajie_uranus_bigtts", "name": "猪八戒 2.0", "gender": "male", "resource_id": "seed-tts-2.0"},
        {"id": "zh_female_ganmaodianyin_uranus_bigtts", "name": "感冒电音姐姐 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "zh_female_chanmeinv_uranus_bigtts", "name": "谄媚女声 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "zh_female_nvleishen_uranus_bigtts", "name": "女雷神 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "zh_female_qinqienv_uranus_bigtts", "name": "亲切女声 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "zh_male_kuailexiaodong_uranus_bigtts", "name": "快乐小东 2.0", "gender": "male", "resource_id": "seed-tts-2.0"},
        {"id": "zh_male_kailangxuezhang_uranus_bigtts", "name": "开朗学长 2.0", "gender": "male", "resource_id": "seed-tts-2.0"},
        {"id": "zh_male_youyoujunzi_uranus_bigtts", "name": "悠悠君子 2.0", "gender": "male", "resource_id": "seed-tts-2.0"},
        {"id": "zh_female_wenjingmaomao_uranus_bigtts", "name": "文静毛毛 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "zh_female_zhixingnv_uranus_bigtts", "name": "知性女声 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "zh_male_qingshuangnanda_uranus_bigtts", "name": "清爽男大 2.0", "gender": "male", "resource_id": "seed-tts-2.0"},
        {"id": "zh_male_yuanboxiaoshu_uranus_bigtts", "name": "渊博小叔 2.0", "gender": "male", "resource_id": "seed-tts-2.0"},
        {"id": "zh_male_yangguangqingnian_uranus_bigtts", "name": "阳光青年 2.0", "gender": "male", "resource_id": "seed-tts-2.0"},
        {"id": "zh_female_qingchezizi_uranus_bigtts", "name": "清澈梓梓 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "zh_female_tianmeiyueyue_uranus_bigtts", "name": "甜美悦悦 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "zh_female_xinlingjitang_uranus_bigtts", "name": "心灵鸡汤 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "zh_male_wenrouxiaoge_uranus_bigtts", "name": "温柔小哥 2.0", "gender": "male", "resource_id": "seed-tts-2.0"},
        {"id": "zh_female_roumeinvyou_uranus_bigtts", "name": "柔美女友 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "zh_male_dongfanghaoran_uranus_bigtts", "name": "东方浩然 2.0", "gender": "male", "resource_id": "seed-tts-2.0"},
        {"id": "zh_female_wenrouxiaoya_uranus_bigtts", "name": "温柔小雅 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "zh_male_tiancaitongsheng_uranus_bigtts", "name": "天才童声 2.0", "gender": "male", "resource_id": "seed-tts-2.0"},
        {"id": "zh_female_wuzetian_uranus_bigtts", "name": "武则天 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "zh_female_guijie_uranus_bigtts", "name": "顾姐 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "zh_male_guanggaojieshuo_uranus_bigtts", "name": "广告解说 2.0", "gender": "male", "resource_id": "seed-tts-2.0"},
        {"id": "zh_female_shaoergushi_uranus_bigtts", "name": "少儿故事 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        # ── 多语种 / ICL（In-Context-Learning）角色音色，同属 2.0 池 ──
        {"id": "ICL_uranus_en_female_charlie_tob", "name": "Charlie 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "ICL_uranus_en_male_ethan_tob", "name": "Ethan 2.0", "gender": "male", "resource_id": "seed-tts-2.0"},
        {"id": "ICL_uranus_en_male_alastor_tob", "name": "Alastor 2.0", "gender": "male", "resource_id": "seed-tts-2.0"},
        {"id": "ICL_uranus_en_male_chucky_tob", "name": "Chucky 2.0", "gender": "male", "resource_id": "seed-tts-2.0"},
        {"id": "ICL_uranus_en_male_noah_tob", "name": "Noah 2.0", "gender": "male", "resource_id": "seed-tts-2.0"},
        {"id": "ICL_uranus_en_male_jigsaw_tob", "name": "Jigsaw 2.0", "gender": "male", "resource_id": "seed-tts-2.0"},
        {"id": "ICL_uranus_en_male_clown_man_tob", "name": "Clown Man 2.0", "gender": "male", "resource_id": "seed-tts-2.0"},
        {"id": "ICL_uranus_en_male_cartoon_chef_tob", "name": "Cartoon Chef 2.0", "gender": "male", "resource_id": "seed-tts-2.0"},
        {"id": "ICL_uranus_en_male_frosty_man_tob", "name": "Frosty Man 2.0", "gender": "male", "resource_id": "seed-tts-2.0"},
        {"id": "ICL_uranus_en_male_the_grinch_tob", "name": "The Grinch 2.0", "gender": "male", "resource_id": "seed-tts-2.0"},
        {"id": "ICL_uranus_en_male_kevin_mccallister_tob", "name": "Kevin McCallister 2.0", "gender": "male", "resource_id": "seed-tts-2.0"},
        {"id": "ICL_uranus_en_male_michael_tob", "name": "Michael 2.0", "gender": "male", "resource_id": "seed-tts-2.0"},
        {"id": "ICL_uranus_en_male_big_boogie_tob", "name": "Big Boogie 2.0", "gender": "male", "resource_id": "seed-tts-2.0"},
        {"id": "ICL_uranus_en_male_xavier_tob", "name": "Xavier 2.0", "gender": "male", "resource_id": "seed-tts-2.0"},
        {"id": "ICL_uranus_en_male_zayne_tob", "name": "Zayne 2.0", "gender": "male", "resource_id": "seed-tts-2.0"},
        {"id": "ICL_uranus_zh_female_kefuwanjun_tob", "name": "客服婉君 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "ICL_uranus_zh_female_aojiaonvyou_tob", "name": "傲娇女友 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "ICL_uranus_zh_female_aomanjiaosheng_tob", "name": "傲慢娇声 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "ICL_uranus_zh_female_xiemeinvwang_tob", "name": "邪魅女王 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "ICL_uranus_zh_female_bingjiaojiejie_tob", "name": "病娇姐姐 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "ICL_uranus_zh_female_bingjiaomengmei_tob", "name": "病娇萌妹 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "ICL_uranus_zh_female_bingruoshaonv_tob", "name": "病弱少女 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "ICL_uranus_zh_female_chengshuwenrou_tob", "name": "成熟温柔 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "ICL_uranus_zh_female_chengshujiejie_tob", "name": "成熟姐姐 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "ICL_uranus_zh_female_chunzhenshaonv_tob", "name": "纯真少女 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "ICL_uranus_zh_female_chunchenvsheng_tob", "name": "纯澈女生 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "ICL_uranus_zh_female_wumeikeren_tob", "name": "妩媚可人 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "ICL_uranus_zh_female_guaiqiaokeer_tob", "name": "乖巧可儿 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "ICL_uranus_zh_female_heainainai_tob", "name": "和蔼奶奶 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "ICL_uranus_zh_female_huopodiaoman_tob", "name": "活泼刁蛮 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "ICL_uranus_zh_female_huoponvhai_tob", "name": "活泼女孩 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "ICL_uranus_zh_female_jiaohannvwang_tob", "name": "娇憨女王 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "ICL_uranus_zh_female_jiaoruoluoli_tob", "name": "娇弱萝莉 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "ICL_uranus_zh_female_jiaxiaozi_tob", "name": "假小子 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
        {"id": "ICL_uranus_zh_female_jinglingxiangdao_tob", "name": "精灵向导 2.0", "gender": "female", "resource_id": "seed-tts-2.0"},
    ]


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
