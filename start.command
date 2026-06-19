#!/bin/bash
#
# 短视频智能混剪工具 - 一键启动脚本 (macOS)
#

set -e

# 进入脚本所在目录
cd "$(dirname "$0")"

echo "========================================"
echo "  短视频智能混剪工具"
echo "  Starting..."
echo "========================================"
echo ""

# ─── 1. 检查并安装前端依赖 ─────────────────────

if [ ! -d "node_modules/.bin" ]; then
  echo "[1/4] 安装前端依赖..."
  npm install --ignore-scripts
else
  echo "[1/4] 前端依赖已存在，跳过"
fi

# ─── 2. 检查并安装 Python 虚拟环境 ──────────────

if [ ! -f "backend/venv/bin/python" ]; then
  echo "[2/4] 创建 Python 虚拟环境..."
  # 尝试找到 Python 3.10+
  PYTHON=""
  for py in python3.12 python3.11 python3.10 python3; do
    if command -v "$py" &>/dev/null; then
      PYTHON="$py"
      break
    fi
  done
  if [ -z "$PYTHON" ]; then
    echo "错误: 未找到 Python 3.10+，请手动安装"
    read -p "按回车退出..."
    exit 1
  fi
  "$PYTHON" -m venv backend/venv
  backend/venv/bin/pip install -r backend/requirements.txt python-multipart httpx
else
  echo "[2/4] Python 虚拟环境已存在，跳过"
fi

# ─── 3. 启动 Python 后端 ──────────────────────

echo "[3/4] 启动 Python 后端..."
backend/venv/bin/python backend/main.py > /tmp/short-video-mashup-backend.log 2>&1 &
BACKEND_PID=$!

# 等待后端就绪，并从日志中提取实际端口
echo "  等待后端启动..."
BACKEND_PORT=""
for i in $(seq 1 30); do
  BACKEND_PORT=$(grep -o 'PORT:[0-9]*' /tmp/short-video-mashup-backend.log 2>/dev/null | cut -d: -f2)
  if [ -n "$BACKEND_PORT" ] && curl -s "http://127.0.0.1:${BACKEND_PORT}/api/health" > /dev/null 2>&1; then
    echo "  后端已就绪 (PID: $BACKEND_PID, Port: $BACKEND_PORT)"
    break
  fi
  sleep 0.3
done

if [ -z "$BACKEND_PORT" ]; then
  BACKEND_PORT=18000
  echo "  警告: 无法确定后端端口，使用默认值 18000"
fi

# ─── 4. 启动 Vite 前端 ────────────────────────

echo "[4/4] 启动前端开发服务器..."
npx vite --host &
VITE_PID=$!
echo "  前端 PID: $VITE_PID"

sleep 2

# ─── 清理函数 ────────────────────────────────

cleanup() {
  echo ""
  echo "正在关闭服务..."
  kill $BACKEND_PID 2>/dev/null
  kill $VITE_PID 2>/dev/null
  echo "已关闭。"
  exit 0
}
trap cleanup INT TERM

# ─── 打开浏览器 ──────────────────────────────

FRONTEND_URL="http://localhost:5173?backend_port=${BACKEND_PORT}"
open "$FRONTEND_URL"

echo ""
echo "========================================"
echo "  ✅ 启动完成！"
echo "  前端: http://localhost:5173"
echo "  后端: http://127.0.0.1:${BACKEND_PORT}"
echo "  按 Ctrl+C 关闭所有服务"
echo "========================================"

# 等待任意子进程退出
wait
