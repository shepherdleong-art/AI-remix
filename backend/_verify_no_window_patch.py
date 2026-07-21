"""验证 config.py 的 subprocess.CREATE_NO_WINDOW monkey patch 是否生效。"""
import sys
import os
import subprocess

# 把 backend 目录加入路径并导入 config（触发 patch）
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import config  # noqa: F401


def main():
    if sys.platform != "win32":
        print("当前非 Windows 平台，patch 未激活（预期行为）")
        return 0

    captured: list[int] = []

    class FakePopen:
        def __init__(self, *args, **kwargs):
            captured.append(kwargs.get("creationflags", 0))
            self.returncode = 0
            self.pid = 0
            self.stdout = None
            self.stderr = None

        def wait(self, timeout=None):
            return 0

    # 把 config patch 最终要调用的原始 init 替换为我们的 FakePopen，
    # 这样可以直接观测到经过 config patch 处理后的 creationflags。
    real_orig = config._orig_popen_init
    config._orig_popen_init = FakePopen.__init__

    try:
        proc = subprocess.Popen(
            [config.FFMPEG_EXECUTABLE, "-version"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        proc.wait()
    finally:
        config._orig_popen_init = real_orig

    expected = subprocess.CREATE_NO_WINDOW
    actual = captured[0] if captured else -1

    print(f"sys.platform     = {sys.platform}")
    print(f"实际收到 flags   = {actual} (hex={actual:#x})")
    print(f"CREATE_NO_WINDOW = {expected} (hex={expected:#x})")

    if (actual & expected) == expected:
        print("PASS: config.py patch 已把 CREATE_NO_WINDOW 注入子进程")
        return 0
    else:
        print("FAIL: config.py patch 未生效")
        return 1


if __name__ == "__main__":
    sys.exit(main())
