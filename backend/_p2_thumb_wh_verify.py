# -*- coding: utf-8 -*-
"""
P2 /thumb w/h 参数真实 HTTP 验证脚本（一次性，非 pytest）。

步骤：
  1. 用项目内置 ffmpeg 生成 lavfi testsrc2 测试素材（自带烧录时间戳）。
  2. 在空闲端口真实拉起 uvicorn（backend main:app）。
  3. 真实 HTTP 请求 /api/ai-editing/thumb：
       a. w=160（9:16）→ 期望 JPEG 尺寸 160 × round(160*1920/1080)=284
       b. w=160&h=90 → 期望 160×90（显式 w+h）
       c. 不带 w/h → 期望全尺寸 1080×1920（旧行为不变）
       d. w=160 重复请求 → 命中缓存（同一路径，秒出）
       e. aspect=3:4&w=160 → 期望 160 × round(160*1920/1440)=213
  4. 用 PIL 实测每个返回 JPEG 的像素尺寸并打印结论。
"""
import os
import socket
import subprocess
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))   # backend/（本脚本位于 backend 内）
BACKEND = HERE
ROOT = os.path.dirname(BACKEND)                     # 项目根
for p in (BACKEND,):
    if p not in sys.path:
        sys.path.insert(0, p)

from config import FFMPEG_EXECUTABLE  # noqa: E402

ART = os.path.join(ROOT, ".p2_thumb_test")
os.makedirs(ART, exist_ok=True)
PORT = 18977


def make_src() -> str:
    src = os.path.join(ART, "src_9x16.mp4")
    if not os.path.exists(src):
        subprocess.run([
            FFMPEG_EXECUTABLE, "-y", "-f", "lavfi",
            "-i", "testsrc2=size=540x960:rate=30:duration=6",
            "-pix_fmt", "yuv420p", src,
        ], capture_output=True, timeout=60, check=True)
    return src


def wait_ready(timeout=30):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/health", timeout=2) as r:
                if r.status == 200:
                    return True
        except Exception:
            time.sleep(0.5)
    return False


def fetch_thumb(path, query, out_name):
    url = f"http://127.0.0.1:{PORT}/api/ai-editing/thumb?path={urllib.request.quote(path)}&{query}"
    t0 = time.time()
    with urllib.request.urlopen(url, timeout=30) as r:
        data = r.read()
    dt = time.time() - t0
    out = os.path.join(ART, out_name)
    with open(out, "wb") as f:
        f.write(data)
    return out, len(data), dt


def jpeg_size(p):
    from PIL import Image
    with Image.open(p) as im:
        return im.size  # (w, h)


def main():
    from PIL import Image  # noqa: F401 — 提前失败，避免白跑
    src = make_src()
    print(f"[setup] 测试素材: {src}")

    # 端口占用检查
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        if s.connect_ex(("127.0.0.1", PORT)) == 0:
            print(f"[FATAL] 端口 {PORT} 已被占用")
            sys.exit(2)

    log_path = os.path.join(ART, "uvicorn_boot.log")
    log_fh = open(log_path, "w", encoding="utf-8", errors="replace")
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", str(PORT)],
        cwd=BACKEND, stdout=log_fh, stderr=log_fh,
    )
    try:
        if not wait_ready():
            print("[FATAL] 后端 30s 内未就绪，启动日志：")
            try:
                print(open(log_path, encoding="utf-8", errors="replace").read()[-2000:])
            except Exception:
                pass
            sys.exit(2)
        print(f"[setup] uvicorn 已就绪 :{PORT}")

        results = []

        # a. w=160, 9:16 → 160x284
        p, n, dt = fetch_thumb(src, "t=1.5&w=160", "a_w160.jpg")
        results.append(("a) w=160 (9:16)", jpeg_size(p), (160, 284), n, dt))

        # b. w=160&h=90 → 160x90
        p, n, dt = fetch_thumb(src, "t=1.5&w=160&h=90", "b_w160h90.jpg")
        results.append(("b) w=160&h=90", jpeg_size(p), (160, 90), n, dt))

        # c. 无 w/h → 1080x1920（旧行为）
        p, n, dt = fetch_thumb(src, "t=1.5", "c_full.jpg")
        results.append(("c) 无 w/h（旧行为）", jpeg_size(p), (1080, 1920), n, dt))

        # d. w=160 重复 → 缓存命中（同尺寸，响应应明显更快）
        p, n, dt2 = fetch_thumb(src, "t=1.5&w=160", "d_w160_again.jpg")
        results.append(("d) w=160 重复（缓存）", jpeg_size(p), (160, 284), n, dt2))

        # e. aspect=3:4&w=160 → h=round(160*1920/1440)=213 → 偶数对齐 212
        p, n, dt = fetch_thumb(src, "t=1.5&aspect=3:4&w=160", "e_34_w160.jpg")
        results.append(("e) w=160 (3:4, 高偶数对齐)", jpeg_size(p), (160, 212), n, dt))

        # f. 尺寸隔离：w=320 与 w=160 不同缓存文件（h=round(568.9)=569 → 偶数对齐 568）
        p, n, dt = fetch_thumb(src, "t=1.5&w=320", "f_w320.jpg")
        results.append(("f) w=320 (9:16, 高偶数对齐)", jpeg_size(p), (320, 568), n, dt))

        print("\n──── /thumb w/h 实测结果 ────")
        ok_all = True
        for name, got, want, nbytes, dt in results:
            ok = got == want
            ok_all &= ok
            print(f"  [{'OK' if ok else 'FAIL'}] {name}: 实测 {got[0]}x{got[1]} 期望 {want[0]}x{want[1]}  ({nbytes}B, {dt*1000:.0f}ms)")

        # 缓存键隔离核对：thumbs 目录中 a/d 应同文件（尺寸一致+字节一致即同缓存），f 为独立文件
        ba = open(os.path.join(ART, "a_w160.jpg"), "rb").read()
        bd = open(os.path.join(ART, "d_w160_again.jpg"), "rb").read()
        bf = open(os.path.join(ART, "f_w320.jpg"), "rb").read()
        same_cache = ba == bd
        diff_cache = ba != bf
        print(f"  [{'OK' if same_cache else 'FAIL'}] 缓存复用：w=160 两次返回字节一致")
        print(f"  [{'OK' if diff_cache else 'FAIL'}] 缓存隔离：w=160 与 w=320 内容不同")
        ok_all &= same_cache and diff_cache

        print(f"\n结论: {'全部通过' if ok_all else '存在失败项'}")
        sys.exit(0 if ok_all else 1)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


if __name__ == "__main__":
    main()
