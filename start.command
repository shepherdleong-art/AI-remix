#!/bin/bash
#
# 短视频智能混剪工具 - 一键启动脚本 (macOS，浏览器模式)
# 后端 + 前端都以后台进程运行，脚本启动后即可退出/关闭本窗口。
# 关闭请运行 stop.command。
#

cd "$(dirname "$0")"

PID_DIR=".dev-pids"
mkdir -p "$PID_DIR"
BACKEND_PID_FILE="$PID_DIR/backend.pid"
VITE_PID_FILE="$PID_DIR/vite.pid"
BACKEND_LOG="/tmp/short-video-mashup-backend.log"
VITE_LOG="/tmp/short-video-mashup-vite.log"

echo "========================================"
echo "  短视频智能混剪工具 - 启动"
echo "========================================"
echo ""

# ─── 0. 检查是否已在运行 ────────────────────────

if [ -f "$BACKEND_PID_FILE" ] && kill -0 "$(cat "$BACKEND_PID_FILE")" 2>/dev/null; then
  echo "检测到后端已在运行 (PID $(cat "$BACKEND_PID_FILE"))。"
  echo "如需重启，请先运行 stop.command，再重新运行本脚本。"
  read -p "按回车退出..."
  exit 1
fi

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

# ─── 3. 启动 Python 后端 (后台，nohup 防止随终端关闭而退出) ───

echo "[3/4] 启动 Python 后端..."
nohup backend/venv/bin/python backend/main.py > "$BACKEND_LOG" 2>&1 &
echo $! > "$BACKEND_PID_FILE"

BACKEND_PORT=""
for i in $(seq 1 30); do
  BACKEND_PORT=$(grep -o 'PORT:[0-9]*' "$BACKEND_LOG" 2>/dev/null | tail -1 | cut -d: -f2)
  if [ -n "$BACKEND_PORT" ] && curl -s "http://127.0.0.1:${BACKEND_PORT}/api/health" > /dev/null 2>&1; then
    echo "  后端已就绪 (PID $(cat "$BACKEND_PID_FILE")，端口 $BACKEND_PORT)"
    break
  fi
  sleep 0.3
done

if [ -z "$BACKEND_PORT" ]; then
  BACKEND_PORT=18000
  echo "  警告: 无法确认后端端口，按默认值 18000 继续（查看日志: $BACKEND_LOG）"
fi

# ─── 4. 启动 Vite 前端 (后台) ──────────────────

echo "[4/4] 启动前端开发服务器..."
nohup npx vite --host > "$VITE_LOG" 2>&1 &
echo $! > "$VITE_PID_FILE"

sleep 2

# ─── 打开浏览器 ──────────────────────────────

FRONTEND_URL="http://localhost:5173?backend_port=${BACKEND_PORT}"
open "$FRONTEND_URL"

echo ""
echo "========================================"
echo "  ✅ 启动完成（后台运行，本窗口可关闭）"
echo "  前端: http://localhost:5173"
echo "  后端: http://127.0.0.1:${BACKEND_PORT}"
echo "  日志: $BACKEND_LOG"
echo "        $VITE_LOG"
echo ""
echo "  关闭服务请运行 stop.command"
echo "========================================"
