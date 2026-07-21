#!/bin/bash
#
# 短视频智能混剪工具 - 一键关闭脚本 (macOS)
# 关闭由 start.command 启动的后端 + 前端后台进程。
#

cd "$(dirname "$0")"

PID_DIR=".dev-pids"
BACKEND_PID_FILE="$PID_DIR/backend.pid"
VITE_PID_FILE="$PID_DIR/vite.pid"

echo "========================================"
echo "  短视频智能混剪工具 - 关闭"
echo "========================================"
echo ""

stop_one() {
  local name="$1"
  local pid_file="$2"

  if [ ! -f "$pid_file" ]; then
    echo "$name: 未在运行（无 PID 文件）"
    return
  fi

  local pid
  pid=$(cat "$pid_file")

  if ! kill -0 "$pid" 2>/dev/null; then
    echo "$name: 进程 $pid 已不存在，清理 PID 文件"
    rm -f "$pid_file"
    return
  fi

  echo "$name: 正在关闭进程 $pid ..."
  kill "$pid" 2>/dev/null

  for i in $(seq 1 20); do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "$name: 已关闭"
      rm -f "$pid_file"
      return
    fi
    sleep 0.2
  done

  echo "$name: 未响应，强制关闭 (kill -9)"
  kill -9 "$pid" 2>/dev/null
  rm -f "$pid_file"
}

stop_one "后端 (Python)" "$BACKEND_PID_FILE"
stop_one "前端 (Vite)" "$VITE_PID_FILE"

echo ""
echo "========================================"
echo "  已全部关闭"
echo "========================================"
read -p "按回车退出..."
