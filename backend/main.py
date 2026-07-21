"""
短视频智能混剪工具 - Python 后端服务

FastAPI 应用入口。负责：
- 在启动时自动选择可用端口，通过 stdout 告知 Electron 主进程
- CORS 中间件配置，允许 localhost 跨域
- 健康检查端点 GET /api/health
- 统一响应格式 { code, message, data }
- 注册各业务模块路由（后续任务扩展）
"""

import sys
import socket
import logging
import atexit
from contextlib import asynccontextmanager

# Configure logging for debugging AI pipeline
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    datefmt="%H:%M:%S",
    stream=sys.stderr,
)

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from config import (
    PORT_RANGE_START,
    PORT_RANGE_END,
    CORS_ALLOWED_ORIGINS,
    APP_TITLE,
    APP_VERSION,
    APP_DESCRIPTION,
    DEV_PORT_FILE,
    TEMP_DIR,
    ANALYSIS_TEMP_DIR,
)
import os
from pathlib import Path


def find_available_port(start: int, end: int) -> int:
    """在指定范围内查找一个可用端口。

    通过尝试 bind 来检测端口是否可用。不设置 SO_REUSEADDR，
    因为在 Windows 上 SO_REUSEADDR 允许绑定已被占用的端口，
    会导致误判端口可用，进而 uvicorn 启动时失败。
    """
    for port in range(start, end + 1):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind(('127.0.0.1', port))
                return port
            except OSError:
                continue
    # 如果范围内所有端口都被占用，抛出异常
    raise RuntimeError(
        f"No available port found in range {start}-{end}"
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期管理。"""
    # 启动时执行
    print("[Backend] Application starting...", file=sys.stderr)
    yield
    # 关闭时执行
    print("[Backend] Application shutting down...", file=sys.stderr)


app = FastAPI(
    title=APP_TITLE,
    version=APP_VERSION,
    description=APP_DESCRIPTION,
    lifespan=lifespan,
)

# ─── CORS 中间件 ────────────────────────────────────────────

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─── 健康检查端点 ───────────────────────────────────────────

@app.get("/api/health")
async def health_check():
    """
    健康检查端点。

    返回统一格式的响应，Electron 主进程通过轮询此端点
    来判断后端是否已就绪。
    """
    return {
        "code": 0,
        "message": "success",
        "data": {
            "status": "healthy",
            "version": APP_VERSION,
        },
    }


# ─── 统一响应辅助函数 ───────────────────────────────────────

def success_response(data=None, message: str = "success"):
    """构建成功响应。"""
    return {
        "code": 0,
        "message": message,
        "data": data,
    }


def error_response(code: int, message: str, data=None):
    """构建错误响应。"""
    return {
        "code": code,
        "message": message,
        "data": data,
    }


# ─── 业务路由注册 ────────────────────────────────────────────

from routes.materials import router as materials_router
from routes.analysis import router as analysis_router
from routes.templates import router as templates_router
from routes.render import router as render_router
from routes.ai_editing import router as ai_editing_router
from routes.projects import router as projects_router
from routes.music import router as music_router
from routes.preview import router as preview_router
from routes.batch import router as batch_router

app.include_router(materials_router)
app.include_router(analysis_router)
app.include_router(templates_router)
app.include_router(render_router)
app.include_router(ai_editing_router)
app.include_router(projects_router)
app.include_router(music_router)
app.include_router(preview_router)
app.include_router(batch_router)


# ─── 缓存清理（启动时） ─────────────────────────────────────

def _janitor() -> None:
    """启动时清理可再生缓存，防止磁盘无限膨胀。

    只清"纯缓存"（删了会自动重建）：预览拼合片、TTS 音频、分析中间帧。
    绝不动 uploads/（项目历史引用着原始上传文件，删了历史会炸）。

    规则（均可环境变量覆盖）：
    - 超龄删除：文件修改时间早于 MASHUP_CACHE_MAX_AGE_DAYS（默认 7 天）
    - 限量删除：previews 总量超 MASHUP_PREVIEW_MAX_MB（默认 2048MB）时从最旧删起
    """
    import time

    max_age_sec = float(os.environ.get("MASHUP_CACHE_MAX_AGE_DAYS", "7")) * 86400
    preview_max_bytes = int(os.environ.get("MASHUP_PREVIEW_MAX_MB", "2048")) * 1024 * 1024
    now = time.time()
    freed = 0

    def _sweep_aged(d: Path) -> None:
        nonlocal freed
        if not d.is_dir():
            return
        for f in d.rglob("*"):
            if not f.is_file():
                continue
            try:
                if now - f.stat().st_mtime > max_age_sec:
                    freed += f.stat().st_size
                    f.unlink()
            except OSError:
                pass

    def _cap_dir(d: Path, cap: int) -> None:
        nonlocal freed
        if not d.is_dir():
            return
        files = [f for f in d.rglob("*") if f.is_file()]
        try:
            files.sort(key=lambda f: f.stat().st_mtime)  # 最旧在前
        except OSError:
            return
        total = sum(f.stat().st_size for f in files if f.exists())
        for f in files:
            if total <= cap:
                break
            try:
                sz = f.stat().st_size
                f.unlink()
                total -= sz
                freed += sz
            except OSError:
                pass

    for d in (TEMP_DIR / "tts", TEMP_DIR / "previews", Path(ANALYSIS_TEMP_DIR)):
        _sweep_aged(d)
    _cap_dir(TEMP_DIR / "previews", preview_max_bytes)

    if freed:
        print(f"[Janitor] 缓存清理完成，释放 {freed / 1024 / 1024:.1f} MB", file=sys.stderr)


# ─── 启动入口 ───────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn

    # 后台线程跑缓存清理，不拖慢启动
    import threading
    threading.Thread(target=_janitor, daemon=True).start()

    # 查找可用端口
    port = find_available_port(PORT_RANGE_START, PORT_RANGE_END)

    # 将实际端口写入开发模式端口文件（供浏览器开发模式下的 Vite 中间件读取）
    # Electron 模式不依赖此文件，通过 stdout 解析端口。
    try:
        DEV_PORT_FILE.write_text(str(port), encoding="utf-8")
        print(f"[Backend] Dev port file written: {DEV_PORT_FILE} (port={port})", file=sys.stderr)
    except OSError as e:
        print(f"[Backend] Warning: Could not write dev port file: {e}", file=sys.stderr)

    # 注册退出时清理端口文件
    def _cleanup_dev_port_file() -> None:
        """进程退出时删除开发模式端口文件。"""
        try:
            DEV_PORT_FILE.unlink(missing_ok=True)
        except OSError:
            pass

    atexit.register(_cleanup_dev_port_file)

    # 通过 stdout 告知 Electron 主进程端口号
    # 格式: "PORT:18080" (Electron python-bridge.ts 会解析此格式)
    print(f"PORT:{port}", flush=True)

    # 启动 uvicorn 服务器
    uvicorn.run(
        "main:app",
        host="127.0.0.1",
        port=port,
        reload=False,
        log_level="info",
    )
