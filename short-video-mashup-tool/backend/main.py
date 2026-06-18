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
)


def find_available_port(start: int, end: int) -> int:
    """在指定范围内查找一个可用端口。"""
    for port in range(start, end + 1):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
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

app.include_router(materials_router)
app.include_router(analysis_router)
app.include_router(templates_router)
app.include_router(render_router)
app.include_router(ai_editing_router)


# ─── 启动入口 ───────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn

    # 查找可用端口
    port = find_available_port(PORT_RANGE_START, PORT_RANGE_END)

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
