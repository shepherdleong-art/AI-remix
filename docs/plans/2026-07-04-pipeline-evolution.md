# 混剪流水线化改造 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **执行方式**：按 Phase 顺序执行，Phase 内按 Task 顺序执行。每个 Task 完成即 commit。每个 Phase 结束跑一遍「统一验收」（见文末）再进入下一期。本文档已锁定所有跨期共享的数据模型与 API 契约——**后期任务必须使用本文档定义的字段名和接口，不要自行改名**。

**Goal:** 把当前"一次只能手工生成一条视频"的 GUI 工具，改造成可被上游项目（素材生成 + 脚本生成）程序化调用、批量产出成品视频（含配音/字幕/BGM/封面标题）的流水线节点。

**Architecture:** 三层改造——(1) 素材分析结果按文件哈希持久化为素材库资产，消除重复 LLM 开销；(2) 混剪全链路改为后端任务队列（提交→轮询→取件），前端和上游都是队列的客户端；(3) 合成路径统一到既有的 `renderer.py` 渲染管线，白捡转场/水印/真实进度，并在其上补 BGM/封面/字幕定位。

**Tech Stack:** 现有栈不变——Electron + React 18/MUI/Zustand 前端，Python FastAPI + FFmpeg/httpx 后端。新增 pytest（仅后端单测）。

---

## 0. 执行者必读：现状关键事实

| 事实 | 位置 |
|---|---|
| 前后端通信统一走 `{code, message, data}` 包络，`code===0` 成功 | `backend/main.py`、`src/renderer/api/backend-client.ts` |
| Electron 模式下 HTTP 走 IPC 代理（`backend:request`），**超时写死 30s** | `src/main/ipc-handlers.ts:134` |
| 后端端口在 18000-18999 随机挑选，通过 stdout `PORT:xxxx` 告知 Electron | `backend/main.py:147`、`src/main/python-bridge.ts` |
| AI 混剪主链路（分析/匹配/合成）是**同步 HTTP 请求**，无任务化 | `backend/routes/ai_editing.py` |
| 已有两套正确的"任务+轮询"参照实现 | `backend/routes/analysis.py`（线程池版）、`backend/services/renderer.py` 的 `RenderQueue`（asyncio 版，**新代码模仿这个**） |
| 铁律 1：`async def` 路由里任何阻塞调用（FFmpeg/OpenCV/大 IO）必须 `await asyncio.to_thread(...)` | 见 CLAUDE.md，历史 P0 事故 |
| 铁律 2：任何按路径出文件的端点必须过 `_is_safe_path()`；新增可服务目录要登记 | `backend/routes/ai_editing.py:507` |
| 铁律 3：drawtext/subtitles 滤镜里的文本必须转义 | `backend/services/renderer.py:35 _escape_drawtext` |
| 后端运行时依赖 `httpx`、`python-multipart` 不在 requirements.txt 里，装环境要额外装 | `start.command:44` |
| 无任何测试框架；本计划在 Phase 1 引入 pytest（仅后端） | — |

跑后端单测（Phase 1 起）：`cd backend && venv/bin/python -m pytest tests/ -v`
跑前端类型检查：`npm run typecheck`

---

## 1. 全局设计决策（所有 Phase 共享，先读完再动手）

### 1.1 目录布局（全部在用户数据目录下，打包后依然可写）

```python
# backend/config.py 新增（Phase 0 Task 0.3 落地）
OUTPUTS_DIR: Path = APPDATA_DIR / "outputs"     # 成品视频 + manifest + 封面
LIBRARY_DIR: Path = APPDATA_DIR / "library"     # 素材资产 JSON + frames/ 子目录
MASHUPS_DIR: Path = APPDATA_DIR / "mashups"     # 混剪任务持久化 JSON
BGM_DIR: Path     = APPDATA_DIR / "bgm"         # 用户背景音乐库
```

### 1.2 素材资产 Schema（`LIBRARY_DIR/{hash_hex}.json`）

```json
{
  "schema_version": 1,
  "file_hash": "qh256:3fa9...",
  "file_path": "/abs/path/a.mp4",
  "file_size": 10485760,
  "scenes": [
    {"index": 0, "start": 0.0, "end": 3.2, "duration": 3.2,
     "description": "海边日落，一人奔跑", "frame_path": "/abs/.../library/frames/3fa9/scene_000.jpg"}
  ],
  "analysis": {"status": "done", "model": "gpt-5.5", "analyzed_at": "2026-07-04T10:00:00Z", "error": ""}
}
```

`file_hash` 用「快速哈希」：size + 头 1MB + 尾 1MB 的 sha256（2GB 视频毫秒级完成，与路径/mtime 无关，复制到新路径仍命中缓存）。

### 1.3 混剪任务（MashupJob）Schema（`MASHUPS_DIR/{job_id}.json`）

```json
{
  "id": "mj_a1b2c3d4e5",
  "status": "pending",
  "progress": 0.0,
  "current_step": "queued",
  "created_at": "2026-07-04T10:00:00Z",
  "completed_at": "",
  "cancel_requested": false,
  "input": {
    "script": "大家好，今天介绍……",
    "material_paths": ["/abs/a.mp4", "/abs/b.mp4"],
    "api_key": "",
    "stop_after": "full",
    "timeline_override": null,
    "output_dir": "",
    "callback_url": "",
    "external_task_id": "",
    "package": {
      "output_name": "ai_edit_1720000000",
      "voice": "Cherry",
      "speed": 1.0,
      "width": 1080,
      "height": 1920,
      "transition": "none",
      "subtitle_style": {"font": "PingFang SC", "font_path": "", "color": "#ffffff",
                          "size": 24, "stroke_color": "#000000", "stroke_width": 2},
      "subtitle_overrides": {},
      "bgm": null,
      "cover": null
    }
  },
  "result": {"timeline": [], "audio_path": "", "output_path": "", "cover_path": "", "manifest_path": ""},
  "error": ""
}
```

字段约定：
- `status`: `pending | processing | done | failed | cancelled`
- `stop_after`: `"timeline"`（跑到时间线为止，供人工微调）或 `"full"`（一路到成品）
- `timeline_override`: 非空时**跳过**文案分析和场景匹配，直接用给定时间线（元素结构 = 现有 `TimelineSegment`：`{segment_index, segment_text, video_path, start_time, duration, source_duration?, reason}`）
- `package.bgm`（Phase 4 启用）: `{"file_path": "/abs/music.mp3", "volume": 0.25, "ducking": true}` 或 `null`
- `package.cover`（Phase 4 启用）: `{"mode": "first_frame", "image_path": "", "title_text": "三大亮点", "title_size": 72, "title_color": "#ffffff", "intro_duration": 0}` 或 `null`

### 1.4 任务进度区间（写死在执行器里，前端据此画进度）

| current_step | progress 区间 | 说明 |
|---|---|---|
| queued | 0 | 排队中 |
| material_prepare | 2 | 校验/注册素材 |
| video_analysis | 5 → 40 | 按素材数均分；库命中时瞬间跳过 |
| script_analysis | 42 | timeline_override 时跳过 |
| scene_matching | 52 | timeline_override 时跳过 |
| tts | 62 | stop_after=timeline 时不会到这 |
| composite | 72 → 98 | Phase 2 为粗略推进，Phase 3 接真实 FFmpeg 帧进度 |
| finalize | 98 | 写 manifest |
| （done） | 100 | |

### 1.5 产物 Manifest（`{output_name}.manifest.json`，与成品同目录）

```json
{
  "schema_version": 1,
  "job_id": "mj_a1b2c3d4e5",
  "external_task_id": "",
  "created_at": "2026-07-04T10:05:00Z",
  "script": "……",
  "package": { "voice": "Cherry", "speed": 1.0, "width": 1080, "height": 1920 },
  "materials": [{"file_path": "/abs/a.mp4", "file_hash": "qh256:3fa9..."}],
  "timeline": [],
  "output": {"video": "/abs/.../outputs/ai_edit_x.mp4", "cover": "", "audio": "/abs/.../narr.mp3",
              "duration_sec": 21.4, "width": 1080, "height": 1920}
}
```

### 1.6 新增配置项（`backend/config.py`，各 Phase 落地时添加）

```python
MASHUP_MAX_CONCURRENT: int = int(os.environ.get("MASHUP_JOBS_CONCURRENT", "2"))      # 任务级并发
MASHUP_FFMPEG_CONCURRENT: int = int(os.environ.get("MASHUP_FFMPEG_CONCURRENT", "1")) # FFmpeg 合成并发
```

### 1.7 分期总览

| Phase | 内容 | 依赖 | 规模 | 交付物 |
|---|---|---|---|---|
| 0 | 清障：硬编码端口、IPC 超时、成品出临时目录 | 无 | 小 | 现有功能在任意端口/长任务下可用 |
| 1 | 素材库资产化（分析缓存） | 0 | 中 | 同素材二次生成零 LLM 调用；前端零改动 |
| 2 | 混剪任务队列 + 批量 + 前端任务面板 | 1 | 大 | 一次提交 N 条文案 → N 条视频排队产出 |
| 3 | 合成统一到 renderer.py 管线（转场/真实进度/外部音轨） | 2 | 中 | 成品带转场，进度条真实 |
| 4 | 包装：BGM ducking、封面标题、字幕定位落地 | 3 | 中 | 成品可直接发布 |
| 5 | 程序化对接：固定端口/headless、任务包 API、webhook、（可选）监听目录 | 2 | 中 | 上游 curl 即可驱动全流程 |

---

## Phase 0：清障（修复阻塞流水线化的既有缺陷）

### Task 0.1 消灭硬编码 `http://127.0.0.1:18000`

**Files:**
- Modify: `src/renderer/api/backend-client.ts`（新增 `getBackendBaseUrl`）
- Modify: `src/renderer/components/render/ExportConfirm.tsx`（删除 :40-49 的本地 `Api` 对象；:146、:311 的媒体 URL）
- Modify: `src/renderer/components/analysis/AiScriptEditor.tsx:111`（preview-voice 的裸 fetch）
- Modify: `grep -rn "127.0.0.1:18000" src/renderer/` 命中的**其余所有文件**（已知 TimelineEditor/TimelinePreview 等预览组件也可能命中，一并修）

- [ ] **Step 1: 在 backend-client.ts 追加动态 base URL helper**

```typescript
// 追加到 src/renderer/api/backend-client.ts 末尾（export default api 之前）

let _cachedBaseUrl: string | null = null;

/**
 * Resolve the backend base URL (e.g. "http://127.0.0.1:18342").
 * Electron mode: asks main process for the actual port.
 * Browser mode: uses the same discovery chain as apiRequest.
 * Used for media URLs (<video src>, <audio src>) and binary fetches
 * that cannot go through the JSON-only IPC proxy.
 */
export async function getBackendBaseUrl(): Promise<string> {
  if (_cachedBaseUrl) return _cachedBaseUrl;

  if (isElectron()) {
    const electronApi = getElectronAPI();
    if (electronApi) {
      try {
        const port = await electronApi.getPythonPort();
        if (port) {
          _cachedBaseUrl = `http://127.0.0.1:${port}`;
          return _cachedBaseUrl;
        }
      } catch {
        // fall through to browser discovery
      }
    }
  }

  const port: number =
    (window as unknown as Record<string, number>).__BACKEND_PORT__ ||
    parseInt(new URLSearchParams(window.location.search).get('backend_port') || '') ||
    18000;
  _cachedBaseUrl = `http://127.0.0.1:${port}`;
  return _cachedBaseUrl;
}
```

- [ ] **Step 2: ExportConfirm.tsx 去掉本地 Api 对象，改用统一客户端**

删除 :40-49 的 `const Api = {...}`，`handleExport` 里 `Api.post(...)` 改为 `api.post('/api/ai-editing/composite', {...}, { timeout: 600000 })`（`import api from '@/renderer/api/backend-client'`；timeout 参数在 Task 0.2 打通）。两处媒体 URL 改为组件内先解析 base：

```typescript
const [backendBase, setBackendBase] = useState<string>('');
useEffect(() => { getBackendBaseUrl().then(setBackendBase); }, []);
// 原 `http://127.0.0.1:18000/api/ai-editing/video?path=...`
// 改为 `${backendBase}/api/ai-editing/video?path=...`（backendBase 为空时不渲染 <video>）
```

- [ ] **Step 3: AiScriptEditor.tsx 的 preview-voice 裸 fetch 改造**

```typescript
const base = await getBackendBaseUrl();
const resp = await fetch(`${base}/api/ai-editing/preview-voice`, { /* 原样 */ });
```

（此接口返回音频二进制，不能走 JSON-only 的 IPC 代理，必须直连；后端 CORS 已放开 `*`，Electron file:// 与浏览器均可直连。）

- [ ] **Step 4: 全库扫尾**

Run: `grep -rn "127.0.0.1:18000" src/renderer/`
Expected: 无输出（全部改为 `getBackendBaseUrl()` 或 `api.*`）。

- [ ] **Step 5: 验证 + 提交**

Run: `npm run typecheck` → 通过。
手动验证：`MASHUP_PORT_START=18500 MASHUP_PORT_END=18510 ./start.command`（强制非 18000 端口），试听音色、导出视频、预览成品均正常。

```bash
git add -A src/renderer && git commit -m "fix: resolve backend port dynamically, remove hardcoded 18000"
```

### Task 0.2 IPC 代理超时可配置（解锁长任务请求）

**Files:**
- Modify: `src/main/ipc-handlers.ts`（`backend:request` handler）
- Modify: `src/preload/index.ts`（类型透传）
- Modify: `src/renderer/api/backend-client.ts`（把 `timeout` 传进 IPC 调用）

- [ ] **Step 1: ipc-handlers.ts 接受 timeoutMs**

`BACKEND_REQUEST` handler 的 options 增加 `timeoutMs?: number`，`http.request` 的 `timeout: 30000` 改为：

```typescript
timeout: Math.min(options.timeoutMs || 30000, 10 * 60 * 1000), // 上限 10 分钟
```

- [ ] **Step 2: preload 和 backend-client 透传**

`preload/index.ts` 的 `backendRequest` options 类型加 `timeoutMs?: number`；`backend-client.ts` 的 Electron 分支把 `timeout` 传为 `timeoutMs`：

```typescript
const response = await electronApi.backendRequest({ method, endpoint, body, headers, timeoutMs: timeout });
```

- [ ] **Step 3: 验证 + 提交**

Run: `npm run typecheck` → 通过。

```bash
git add src/main/ipc-handlers.ts src/preload/index.ts src/renderer/api/backend-client.ts
git commit -m "feat: forward per-request timeout through IPC backend proxy"
```

### Task 0.3 成品移出临时目录 + 新目录纳入安全服务范围

**Files:**
- Modify: `backend/config.py`（新增 1.1 节的四个目录常量并 mkdir）
- Modify: `backend/routes/ai_editing.py`（composite / full-pipeline 的 `output_dir` 从 `TEMP_DIR/outputs` 改为 `OUTPUTS_DIR`；`_is_safe_path` 增加 OUTPUTS_DIR、LIBRARY_DIR、BGM_DIR 白名单）

- [ ] **Step 1: config.py 添加目录常量**（照抄 1.1 节代码，加 `for d in (OUTPUTS_DIR, LIBRARY_DIR, LIBRARY_DIR / "frames", MASHUPS_DIR, BGM_DIR): d.mkdir(parents=True, exist_ok=True)`）

- [ ] **Step 2: `_is_safe_path` 扩展白名单**

在现有 TEMP_DIR 检查后追加（同样的 `Path(real_path).relative_to(...)` 写法）：

```python
for allowed_dir in (OUTPUTS_DIR, LIBRARY_DIR, BGM_DIR):
    try:
        Path(real_path).relative_to(str(allowed_dir.resolve()))
        return True
    except ValueError:
        pass
```

- [ ] **Step 3: composite/full-pipeline 输出路径切换**

`ai_editing.py` 两处 `output_dir = os.path.join(TEMP_DIR, "outputs")` 改为 `output_dir = str(OUTPUTS_DIR)`。

- [ ] **Step 4: 验证 + 提交**

启动后端跑一次导出，确认成品落在 `~/Library/Application Support/short-video-mashup-tool/outputs/`，且 Electron 菜单里"清理临时文件"后成品仍在、预览可播。

```bash
git add backend/config.py backend/routes/ai_editing.py
git commit -m "feat: persist outputs under app data dir, whitelist new dirs for serving"
```

---

## Phase 1：素材库资产化（分析缓存）

> 本期完成后：`analyze-video` 端点行为不变、响应结构不变（**前端零改动**），但内部先查库、未命中才分析并落盘。同素材第二次分析 <1s、零 LLM 调用。

### Task 1.1 引入 pytest

**Files:**
- Create: `backend/requirements-dev.txt`
- Create: `backend/tests/__init__.py`（空文件）
- Create: `backend/tests/conftest.py`

- [ ] **Step 1: 写依赖与 conftest**

`backend/requirements-dev.txt`:
```
pytest==8.3.4
pytest-asyncio==0.25.0
```

`backend/tests/conftest.py`:
```python
import sys
from pathlib import Path

# 让测试能 import backend 顶层模块（config、services 等）
sys.path.insert(0, str(Path(__file__).parent.parent))
```

- [ ] **Step 2: 安装并空跑**

Run: `backend/venv/bin/pip install -r backend/requirements-dev.txt && cd backend && venv/bin/python -m pytest tests/ -v`
Expected: `no tests ran`（无报错）。

```bash
git add backend/requirements-dev.txt backend/tests/
git commit -m "chore: add pytest scaffolding for backend"
```

### Task 1.2 快速哈希（TDD）

**Files:**
- Create: `backend/services/material_library.py`
- Test: `backend/tests/test_material_library.py`

- [ ] **Step 1: 写失败的测试**

```python
# backend/tests/test_material_library.py
import os
from services.material_library import quick_hash


def _write(tmp_path, name, data: bytes):
    p = tmp_path / name
    p.write_bytes(data)
    return str(p)


def test_quick_hash_stable_across_paths(tmp_path):
    data = os.urandom(3 * 1024 * 1024)  # 3MB，覆盖头尾采样分支
    a = _write(tmp_path, "a.mp4", data)
    b = _write(tmp_path, "sub_b.mp4", data)
    assert quick_hash(a) == quick_hash(b)
    assert quick_hash(a).startswith("qh256:")


def test_quick_hash_changes_with_content(tmp_path):
    data = os.urandom(3 * 1024 * 1024)
    a = _write(tmp_path, "a.mp4", data)
    c = _write(tmp_path, "c.mp4", data + b"x")
    assert quick_hash(a) != quick_hash(c)


def test_quick_hash_small_file(tmp_path):
    a = _write(tmp_path, "tiny.mp4", b"hello")
    assert quick_hash(a).startswith("qh256:")
```

Run: `cd backend && venv/bin/python -m pytest tests/test_material_library.py -v`
Expected: FAIL（模块不存在）。

- [ ] **Step 2: 实现**

```python
# backend/services/material_library.py
"""
Material library: persistent per-file analysis cache.

Asset JSON schema: see docs/plans/2026-07-04-pipeline-evolution.md §1.2
Keyed by quick_hash (size + head 1MB + tail 1MB sha256) — path/mtime independent.
"""
import os
import json
import asyncio
import hashlib
import logging
import time
from pathlib import Path
from typing import Optional

from config import LIBRARY_DIR

logger = logging.getLogger(__name__)

_SAMPLE_SIZE = 1024 * 1024  # 1MB


def quick_hash(file_path: str) -> str:
    """Fast content fingerprint: sha256 over (size, first 1MB, last 1MB)."""
    size = os.path.getsize(file_path)
    h = hashlib.sha256()
    h.update(str(size).encode())
    with open(file_path, "rb") as f:
        h.update(f.read(_SAMPLE_SIZE))
        if size > _SAMPLE_SIZE * 2:
            f.seek(-_SAMPLE_SIZE, os.SEEK_END)
            h.update(f.read(_SAMPLE_SIZE))
    return f"qh256:{h.hexdigest()}"


def _asset_path(file_hash: str) -> Path:
    return LIBRARY_DIR / f"{file_hash.split(':', 1)[1]}.json"


def load_asset(file_hash: str) -> Optional[dict]:
    p = _asset_path(file_hash)
    if not p.exists():
        return None
    try:
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return None


def save_asset(asset: dict) -> None:
    p = _asset_path(asset["file_hash"])
    tmp = p.with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(asset, f, ensure_ascii=False, indent=2)
    os.replace(tmp, p)


def list_assets() -> list[dict]:
    out = []
    for p in sorted(LIBRARY_DIR.glob("*.json")):
        try:
            with open(p, "r", encoding="utf-8") as f:
                out.append(json.load(f))
        except (json.JSONDecodeError, OSError):
            continue
    return out
```

- [ ] **Step 3: 测试通过 + 提交**

Run: `cd backend && venv/bin/python -m pytest tests/test_material_library.py -v`
Expected: 3 PASS。

```bash
git add backend/services/material_library.py backend/tests/test_material_library.py
git commit -m "feat: material library quick hash + asset persistence"
```

### Task 1.3 `get_or_analyze`：查库 → 未命中才分析

**Files:**
- Modify: `backend/services/material_library.py`
- Test: `backend/tests/test_material_library.py`（追加）

- [ ] **Step 1: 追加失败测试（monkeypatch 掉真实分析，验证缓存命中不再调分析）**

```python
import pytest
from services import material_library


@pytest.mark.asyncio
async def test_get_or_analyze_hits_cache(tmp_path, monkeypatch):
    video = _write(tmp_path, "v.mp4", os.urandom(1024))
    calls = {"n": 0}

    async def fake_analyze(path, api_key):
        calls["n"] += 1
        return [{"index": 0, "start": 0.0, "end": 2.0, "duration": 2.0,
                 "description": "测试场景", "frame_path": ""}]

    monkeypatch.setattr(material_library, "_analyze_file", fake_analyze)
    a1 = await material_library.get_or_analyze(video, "")
    a2 = await material_library.get_or_analyze(video, "")
    assert calls["n"] == 1
    assert a1["file_hash"] == a2["file_hash"]
    assert a2["scenes"][0]["description"] == "测试场景"
```

Run 期望 FAIL（函数不存在）。

- [ ] **Step 2: 实现（注意：分析用 asyncio 锁做同哈希去重；阻塞调用全部 to_thread）**

```python
# 追加到 backend/services/material_library.py

from services.video_service import detect_scenes, extract_scene_frames

_inflight_locks: dict[str, asyncio.Lock] = {}


async def _analyze_file(file_path: str, api_key: str) -> list[dict]:
    """Run scene detection + frame extraction + vision description. Returns scenes list (§1.2)."""
    from services.ai_service import analyze_frames_batch  # 延迟导入避免循环依赖

    scenes = await asyncio.to_thread(detect_scenes, file_path)
    if not scenes:
        return []
    fhash = await asyncio.to_thread(quick_hash, file_path)
    fhash_dir = str(LIBRARY_DIR / "frames" / fhash.split(":", 1)[1])
    frame_paths = await asyncio.to_thread(extract_scene_frames, file_path, scenes, fhash_dir)
    prompts = [f"时间点 {s['start']:.1f}s-{s['end']:.1f}s" for s in scenes]
    descriptions = await analyze_frames_batch(frame_paths, prompts, api_key)
    return [
        {
            "index": i,
            "start": s["start"],
            "end": s["end"],
            "duration": s["duration"],
            "description": descriptions[i] if i < len(descriptions) else "",
            "frame_path": frame_paths[i] if i < len(frame_paths) else "",
        }
        for i, s in enumerate(scenes)
    ]


async def get_or_analyze(file_path: str, api_key: str = "") -> dict:
    """Return the cached asset for a file, analyzing (and persisting) on first sight."""
    fhash = await asyncio.to_thread(quick_hash, file_path)
    cached = load_asset(fhash)
    if cached and cached.get("analysis", {}).get("status") == "done":
        return cached

    lock = _inflight_locks.setdefault(fhash, asyncio.Lock())
    async with lock:
        cached = load_asset(fhash)  # double-check：等锁期间可能已被别人写入
        if cached and cached.get("analysis", {}).get("status") == "done":
            return cached

        asset = {
            "schema_version": 1,
            "file_hash": fhash,
            "file_path": file_path,
            "file_size": os.path.getsize(file_path),
            "scenes": [],
            "analysis": {"status": "processing", "model": "", "analyzed_at": "", "error": ""},
        }
        try:
            from config import AI_VISION_MODEL
            asset["scenes"] = await _analyze_file(file_path, api_key)
            asset["analysis"] = {
                "status": "done",
                "model": AI_VISION_MODEL,
                "analyzed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "error": "",
            }
        except Exception as e:
            asset["analysis"] = {"status": "error", "model": "", "analyzed_at": "", "error": str(e)}
            raise
        finally:
            save_asset(asset)
        return asset
```

- [ ] **Step 3: 测试通过 + 提交**

Run: `cd backend && venv/bin/python -m pytest tests/ -v` → 全 PASS。

```bash
git add backend/services/material_library.py backend/tests/test_material_library.py
git commit -m "feat: get_or_analyze with in-flight dedup and persistent cache"
```

### Task 1.4 `analyze-video` 端点接入缓存（响应结构不变）

**Files:**
- Modify: `backend/routes/ai_editing.py:68-104`（`analyze_video_endpoint`）

- [ ] **Step 1: 替换端点内部实现**

```python
@router.post("/analyze-video")
async def analyze_video_endpoint(req: dict):
    """Detect scenes in a video and describe each with AI vision (library-cached)."""
    video_path = req.get("file_path", "")
    api_key = req.get("api_key", "")
    if not video_path or not os.path.exists(video_path):
        return _err(40001, "视频文件不存在")

    register_material_path(video_path)

    try:
        from services.material_library import get_or_analyze
        asset = await get_or_analyze(video_path, api_key)
        scenes = [
            {"index": s["index"], "start": s["start"], "end": s["end"], "duration": s["duration"]}
            for s in asset["scenes"]
        ]
        return _ok({
            "scenes": scenes,
            "descriptions": [s["description"] for s in asset["scenes"]],
            "frames": [s["frame_path"] for s in asset["scenes"]],
            "frame_count": len(asset["scenes"]),
            "video_path": video_path,
            "cached": asset["analysis"]["analyzed_at"],
        })
    except Exception as e:
        return _err(50001, f"视频分析失败: {str(e)}")
```

- [ ] **Step 2: 素材库查询端点（顺手，供 Phase 2/前端用）**

在 `ai_editing.py` 同文件追加：

```python
@router.get("/library")
async def list_library():
    """List all analyzed material assets."""
    from services.material_library import list_assets
    assets = list_assets()
    return _ok({"assets": assets, "count": len(assets)})
```

- [ ] **Step 3: 验收 + 提交**

手动验收：同一批素材跑两次"开始 AI 剪辑"，第二次"分析视频"步骤 <2s，后端日志（stderr）无 `Vision API` 调用记录；`curl http://127.0.0.1:<port>/api/ai-editing/library` 能看到资产。

```bash
git add backend/routes/ai_editing.py
git commit -m "feat: analyze-video served from material library cache"
```

---

## Phase 2：混剪任务队列 + 批量产出

> 本期完成后：混剪是后端任务，前端只是提交/轮询/展示；一次可提交 N 条文案批量出片；刷新页面任务照跑。

### Task 2.1 MashupQueue 核心（仿 RenderQueue 的 asyncio 队列，多 worker）

**Files:**
- Create: `backend/services/mashup_queue.py`
- Modify: `backend/config.py`（加 §1.6 两个配置项）
- Test: `backend/tests/test_mashup_queue.py`

- [ ] **Step 1: 写失败测试（用假步骤函数验证：状态流转、进度推进、timeline_override 跳过分析、stop_after=timeline 提前结束、持久化落盘）**

```python
# backend/tests/test_mashup_queue.py
import asyncio
import json
import pytest
from services import mashup_queue
from services.mashup_queue import MashupQueue


@pytest.fixture
def queue(tmp_path, monkeypatch):
    monkeypatch.setattr(mashup_queue, "MASHUPS_DIR", tmp_path)
    q = MashupQueue()
    # 替换真实执行步骤为可控假实现
    async def fake_prepare(job): return [{"file_hash": "qh256:x", "file_path": "/a.mp4",
        "scenes": [{"index": 0, "start": 0.0, "end": 5.0, "duration": 5.0, "description": "d", "frame_path": ""}]}]
    async def fake_script(script, key): return [{"index": 0, "text": "t", "keywords": [], "duration_hint": 3}]
    async def fake_match(segs, scenes, key): return [{"segment_index": 0, "segment_text": "t",
        "video_path": "/a.mp4", "start_time": 0.0, "duration": 3.0, "source_duration": 5.0, "reason": ""}]
    async def fake_tts(job): return ("/tmp/narr.mp3", 3.0)
    async def fake_composite(job, timeline, audio): return "/tmp/out.mp4"
    monkeypatch.setattr(q, "_prepare_materials", fake_prepare)
    monkeypatch.setattr(q, "_analyze_script", fake_script)
    monkeypatch.setattr(q, "_match_scenes", fake_match)
    monkeypatch.setattr(q, "_run_tts", fake_tts)
    monkeypatch.setattr(q, "_run_composite", fake_composite)
    return q


def _payload(**kw):
    base = {"script": "文案", "material_paths": ["/a.mp4"], "api_key": "",
            "stop_after": "full", "timeline_override": None, "output_dir": "",
            "callback_url": "", "external_task_id": "", "package": {"output_name": "t"}}
    base.update(kw)
    return base


@pytest.mark.asyncio
async def test_full_job_completes(queue, tmp_path):
    job = queue.create_job(_payload())
    for _ in range(100):
        await asyncio.sleep(0.02)
        if queue.get_job(job["id"])["status"] in ("done", "failed"):
            break
    j = queue.get_job(job["id"])
    assert j["status"] == "done"
    assert j["progress"] == 100
    assert j["result"]["output_path"] == "/tmp/out.mp4"
    assert json.loads((tmp_path / f"{job['id']}.json").read_text())["status"] == "done"


@pytest.mark.asyncio
async def test_stop_after_timeline(queue):
    job = queue.create_job(_payload(stop_after="timeline"))
    for _ in range(100):
        await asyncio.sleep(0.02)
        if queue.get_job(job["id"])["status"] in ("done", "failed"):
            break
    j = queue.get_job(job["id"])
    assert j["status"] == "done"
    assert j["result"]["timeline"]
    assert j["result"]["output_path"] == ""


@pytest.mark.asyncio
async def test_timeline_override_skips_matching(queue, monkeypatch):
    async def boom(*a, **k): raise AssertionError("should not be called")
    monkeypatch.setattr(queue, "_analyze_script", boom)
    monkeypatch.setattr(queue, "_match_scenes", boom)
    tl = [{"segment_index": 0, "segment_text": "x", "video_path": "/a.mp4",
           "start_time": 0.0, "duration": 2.0, "reason": ""}]
    job = queue.create_job(_payload(timeline_override=tl))
    for _ in range(100):
        await asyncio.sleep(0.02)
        if queue.get_job(job["id"])["status"] in ("done", "failed"):
            break
    assert queue.get_job(job["id"])["status"] == "done"
```

Run 期望 FAIL。

- [ ] **Step 2: 实现 MashupQueue**

```python
# backend/services/mashup_queue.py
"""
Mashup job queue: submit → background workers → poll → collect.

Job schema / progress bands: docs/plans/2026-07-04-pipeline-evolution.md §1.3-1.4
Modeled on services/renderer.py::RenderQueue (asyncio queue + JSON persistence),
but with N concurrent workers (LLM steps parallelize well) and an FFmpeg semaphore.
"""
import os
import json
import asyncio
import logging
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Dict, Any

from config import (
    MASHUPS_DIR,
    OUTPUTS_DIR,
    MASHUP_MAX_CONCURRENT,
    MASHUP_FFMPEG_CONCURRENT,
)

logger = logging.getLogger(__name__)


class MashupCancelled(Exception):
    pass


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class MashupQueue:
    def __init__(self):
        self._queue: asyncio.Queue = asyncio.Queue(maxsize=500)
        self._jobs: Dict[str, dict] = {}
        self._workers_started = False
        self._ffmpeg_sem = asyncio.Semaphore(MASHUP_FFMPEG_CONCURRENT)
        self._load_persisted()

    # ── persistence ─────────────────────────────
    def _load_persisted(self) -> None:
        for p in Path(MASHUPS_DIR).glob("*.json"):
            try:
                job = json.loads(p.read_text(encoding="utf-8"))
                if job.get("status") in ("pending", "processing"):
                    job["status"] = "failed"
                    job["error"] = "服务重启，任务中断"
                    p.write_text(json.dumps(job, ensure_ascii=False, indent=2), encoding="utf-8")
                self._jobs[job["id"]] = job
            except (json.JSONDecodeError, OSError, KeyError):
                continue

    def _persist(self, job_id: str) -> None:
        job = self._jobs.get(job_id)
        if not job:
            return
        try:
            (Path(MASHUPS_DIR) / f"{job_id}.json").write_text(
                json.dumps(job, ensure_ascii=False, indent=2), encoding="utf-8")
        except OSError:
            pass

    # ── public API ──────────────────────────────
    def create_job(self, payload: dict) -> dict:
        job_id = "mj_" + uuid.uuid4().hex[:10]
        job = {
            "id": job_id, "status": "pending", "progress": 0.0,
            "current_step": "queued", "created_at": _now(), "completed_at": "",
            "cancel_requested": False,
            "input": {
                "script": payload.get("script", ""),
                "material_paths": payload.get("material_paths", []),
                "api_key": payload.get("api_key", ""),
                "stop_after": payload.get("stop_after", "full"),
                "timeline_override": payload.get("timeline_override"),
                "output_dir": payload.get("output_dir", ""),
                "callback_url": payload.get("callback_url", ""),
                "external_task_id": payload.get("external_task_id", ""),
                "package": payload.get("package", {}),
            },
            "result": {"timeline": [], "audio_path": "", "output_path": "",
                        "cover_path": "", "manifest_path": ""},
            "error": "",
        }
        self._jobs[job_id] = job
        self._persist(job_id)
        self._queue.put_nowait(job_id)
        self._ensure_workers()
        return job

    def get_job(self, job_id: str) -> Optional[dict]:
        return self._jobs.get(job_id)

    def list_jobs(self) -> list[dict]:
        return sorted(self._jobs.values(), key=lambda j: j["created_at"], reverse=True)

    def cancel_job(self, job_id: str) -> bool:
        job = self._jobs.get(job_id)
        if not job or job["status"] in ("done", "failed", "cancelled"):
            return False
        job["cancel_requested"] = True
        if job["status"] == "pending":
            job["status"] = "cancelled"
            job["completed_at"] = _now()
        self._persist(job_id)
        return True

    def delete_job(self, job_id: str) -> bool:
        job = self._jobs.get(job_id)
        if not job or job["status"] == "processing":
            return False
        self._jobs.pop(job_id, None)
        try:
            (Path(MASHUPS_DIR) / f"{job_id}.json").unlink(missing_ok=True)
        except OSError:
            pass
        return True

    # ── workers ─────────────────────────────────
    def _ensure_workers(self) -> None:
        if not self._workers_started:
            self._workers_started = True
            for _ in range(MASHUP_MAX_CONCURRENT):
                asyncio.get_running_loop().create_task(self._worker())

    async def _worker(self) -> None:
        while True:
            job_id = await self._queue.get()
            job = self._jobs.get(job_id)
            if not job or job["status"] != "pending":
                self._queue.task_done()
                continue
            try:
                await self._run_job(job)
            except MashupCancelled:
                job["status"] = "cancelled"
            except Exception as e:
                logger.exception("mashup job %s failed", job_id)
                job["status"] = "failed"
                job["error"] = str(e)
            job["completed_at"] = _now()
            self._persist(job_id)
            await self._fire_callback(job)
            self._queue.task_done()

    def _step(self, job: dict, name: str, pct: float) -> None:
        if job["cancel_requested"]:
            raise MashupCancelled()
        job["current_step"] = name
        job["progress"] = pct
        self._persist(job["id"])

    async def _run_job(self, job: dict) -> None:
        inp = job["input"]
        job["status"] = "processing"
        self._step(job, "material_prepare", 2)
        assets = await self._prepare_materials(job)

        timeline = inp.get("timeline_override")
        if not timeline:
            self._step(job, "script_analysis", 42)
            segments = await self._analyze_script(inp["script"], inp["api_key"])
            self._step(job, "scene_matching", 52)
            scenes = self._flatten_scenes(assets)
            timeline = await self._match_scenes(segments, scenes, inp["api_key"])
        job["result"]["timeline"] = timeline

        if inp.get("stop_after") == "timeline":
            job["status"] = "done"
            job["progress"] = 100.0
            job["current_step"] = "done"
            return

        self._step(job, "tts", 62)
        audio_path, audio_duration = await self._run_tts(job)
        job["result"]["audio_path"] = audio_path
        timeline = self._scale_timeline(timeline, audio_duration)
        job["result"]["timeline"] = timeline

        self._step(job, "composite", 72)
        async with self._ffmpeg_sem:
            output_path = await self._run_composite(job, timeline, audio_path)
        job["result"]["output_path"] = output_path

        self._step(job, "finalize", 98)
        job["result"]["manifest_path"] = self._write_manifest(job, assets, audio_duration)
        job["status"] = "done"
        job["progress"] = 100.0
        job["current_step"] = "done"

    # ── steps（真实实现；测试里会被替换） ─────────
    async def _prepare_materials(self, job: dict) -> list[dict]:
        from services.material_library import get_or_analyze
        from routes.ai_editing import register_material_path
        inp = job["input"]
        paths = [p for p in inp["material_paths"] if os.path.exists(p)]
        if not paths:
            raise ValueError("没有可用素材文件")
        assets = []
        n = len(paths)
        for i, p in enumerate(paths):
            register_material_path(p)
            assets.append(await get_or_analyze(p, inp["api_key"]))
            self._step(job, "video_analysis", 5 + 35.0 * (i + 1) / n)
        return assets

    async def _analyze_script(self, script: str, api_key: str) -> list[dict]:
        from services.ai_service import analyze_script
        return await analyze_script(script, api_key)

    async def _match_scenes(self, segments, scenes, api_key: str) -> list[dict]:
        from services.ai_service import match_scenes_to_segments
        return await match_scenes_to_segments(segments, scenes, api_key)

    async def _run_tts(self, job: dict) -> tuple[str, float]:
        from services.ai_service import text_to_speech
        from services.video_service import get_audio_duration
        inp = job["input"]
        pkg = inp["package"]
        out = str(OUTPUTS_DIR / f"{pkg.get('output_name', job['id'])}_narration.mp3")
        await text_to_speech(inp["script"], pkg.get("voice", "Cherry"), out,
                             inp["api_key"], float(pkg.get("speed", 1.0)))
        duration = await asyncio.to_thread(get_audio_duration, out)
        return out, duration

    async def _run_composite(self, job: dict, timeline: list[dict], audio_path: str) -> str:
        # Phase 2：走既有 composite_clip；Phase 3 Task 3.3 会把这里换成统一渲染管线
        from services.video_service import composite_clip
        inp = job["input"]
        pkg = inp["package"]
        out_dir = inp.get("output_dir") or str(OUTPUTS_DIR)
        os.makedirs(out_dir, exist_ok=True)
        output_path = os.path.join(out_dir, f"{pkg.get('output_name', job['id'])}.mp4")
        segments = [
            {"video_path": t["video_path"], "start_time": t["start_time"],
             "duration": t["duration"], "segment_text": t.get("segment_text", "")}
            for t in timeline
        ]
        subtitle_style = pkg.get("subtitle_style")
        return await asyncio.to_thread(
            composite_clip, segments, audio_path, output_path,
            int(pkg.get("width", 1080)), int(pkg.get("height", 1920)), subtitle_style,
        )

    # ── helpers ─────────────────────────────────
    @staticmethod
    def _flatten_scenes(assets: list[dict]) -> list[dict]:
        scenes = []
        for a in assets:
            for s in a["scenes"]:
                scenes.append({
                    "index": len(scenes), "description": s["description"],
                    "video_path": a["file_path"], "start": s["start"],
                    "end": s["end"], "duration": s["duration"],
                })
        return scenes

    @staticmethod
    def _scale_timeline(timeline: list[dict], audio_duration: float) -> list[dict]:
        """缩放各片段时长，使总时长贴合口播音轨（原前端 AiScriptEditor 逻辑收编到后端）。"""
        total = sum(float(t.get("duration", 0)) for t in timeline)
        if total <= 0 or audio_duration <= 0:
            return timeline
        scale = audio_duration / total
        return [{**t, "duration": max(0.5, round(float(t["duration"]) * scale, 1))} for t in timeline]

    def _write_manifest(self, job: dict, assets: list[dict], audio_duration: float) -> str:
        inp = job["input"]
        pkg = inp["package"]
        out_video = job["result"]["output_path"]
        manifest = {
            "schema_version": 1,
            "job_id": job["id"],
            "external_task_id": inp.get("external_task_id", ""),
            "created_at": _now(),
            "script": inp["script"],
            "package": pkg,
            "materials": [{"file_path": a["file_path"], "file_hash": a["file_hash"]} for a in assets],
            "timeline": job["result"]["timeline"],
            "output": {
                "video": out_video,
                "cover": job["result"].get("cover_path", ""),
                "audio": job["result"]["audio_path"],
                "duration_sec": round(audio_duration, 2),
                "width": int(pkg.get("width", 1080)),
                "height": int(pkg.get("height", 1920)),
            },
        }
        path = os.path.splitext(out_video)[0] + ".manifest.json" if out_video else \
            str(Path(MASHUPS_DIR) / f"{job['id']}.manifest.json")
        try:
            Path(path).write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        except OSError:
            return ""
        return path

    async def _fire_callback(self, job: dict) -> None:
        url = job["input"].get("callback_url", "")
        if not url:
            return
        try:
            import httpx
            async with httpx.AsyncClient(timeout=10.0) as client:
                await client.post(url, json={
                    "job_id": job["id"], "status": job["status"],
                    "external_task_id": job["input"].get("external_task_id", ""),
                    "output_path": job["result"].get("output_path", ""),
                    "manifest_path": job["result"].get("manifest_path", ""),
                    "error": job["error"],
                })
        except Exception as e:
            logger.warning("callback to %s failed: %s", url, e)


_instance: Optional[MashupQueue] = None


def get_mashup_queue() -> MashupQueue:
    global _instance
    if _instance is None:
        _instance = MashupQueue()
    return _instance
```

- [ ] **Step 3: 测试通过 + 提交**

Run: `cd backend && venv/bin/python -m pytest tests/test_mashup_queue.py -v` → 全 PASS。

```bash
git add backend/services/mashup_queue.py backend/config.py backend/tests/test_mashup_queue.py
git commit -m "feat: mashup job queue with N workers, persistence, manifest, callback"
```

### Task 2.2 任务路由

**Files:**
- Create: `backend/routes/mashup.py`
- Modify: `backend/main.py`（注册 router）

- [ ] **Step 1: 路由实现（契约固定如下，Phase 5 和前端都依赖）**

```python
# backend/routes/mashup.py
"""
Mashup job API.

POST   /api/mashup/jobs            — 提交单个任务（body = §1.3 input 字段的扁平版）
POST   /api/mashup/jobs/batch      — 批量：{material_paths, package, api_key, scripts: [..]}
GET    /api/mashup/jobs            — 任务列表
GET    /api/mashup/jobs/{id}       — 单任务状态/结果
POST   /api/mashup/jobs/{id}/cancel
DELETE /api/mashup/jobs/{id}
"""
import os
from fastapi import APIRouter

from services.mashup_queue import get_mashup_queue

router = APIRouter(prefix="/api/mashup", tags=["mashup"])


def _ok(data=None, msg="success"):
    return {"code": 0, "message": msg, "data": data}


def _err(code: int, msg: str):
    return {"code": code, "message": msg, "data": None}


def _validate(payload: dict) -> str:
    if not payload.get("timeline_override") and not payload.get("script", "").strip():
        return "缺少 script"
    paths = payload.get("material_paths", [])
    if not paths:
        return "缺少 material_paths"
    missing = [p for p in paths if not os.path.exists(p)]
    if missing:
        return f"素材不存在: {missing[:3]}"
    return ""


@router.post("/jobs")
async def create_job(payload: dict):
    msg = _validate(payload)
    if msg:
        return _err(40001, msg)
    job = get_mashup_queue().create_job(payload)
    return _ok({"job_id": job["id"]}, "任务已提交")


@router.post("/jobs/batch")
async def create_jobs_batch(payload: dict):
    scripts = [s for s in payload.get("scripts", []) if s.strip()]
    if not scripts:
        return _err(40001, "缺少 scripts")
    base = {k: v for k, v in payload.items() if k != "scripts"}
    job_ids = []
    for i, script in enumerate(scripts):
        p = dict(base)
        p["script"] = script
        pkg = dict(p.get("package", {}))
        pkg["output_name"] = f"{pkg.get('output_name', 'batch')}_{i + 1:02d}"
        p["package"] = pkg
        msg = _validate(p)
        if msg:
            return _err(40001, f"第{i + 1}条: {msg}")
        job_ids.append(get_mashup_queue().create_job(p)["id"])
    return _ok({"job_ids": job_ids}, f"已提交 {len(job_ids)} 个任务")


@router.get("/jobs")
async def list_jobs():
    return _ok({"jobs": get_mashup_queue().list_jobs()})


@router.get("/jobs/{job_id}")
async def get_job(job_id: str):
    job = get_mashup_queue().get_job(job_id)
    if not job:
        return _err(40004, f"任务不存在: {job_id}")
    return _ok(job)


@router.post("/jobs/{job_id}/cancel")
async def cancel_job(job_id: str):
    if not get_mashup_queue().cancel_job(job_id):
        return _err(40009, "取消失败：任务不存在或已结束")
    return _ok(None, "已请求取消")


@router.delete("/jobs/{job_id}")
async def delete_job(job_id: str):
    if not get_mashup_queue().delete_job(job_id):
        return _err(40009, "删除失败：任务不存在或正在执行")
    return _ok(None, "已删除")
```

`main.py` 注册：`from routes.mashup import router as mashup_router` + `app.include_router(mashup_router)`。

- [ ] **Step 2: curl 验收 + 提交**

```bash
PORT=$(grep -o 'PORT:[0-9]*' /tmp/short-video-mashup-backend.log | tail -1 | cut -d: -f2)
curl -s -X POST http://127.0.0.1:$PORT/api/mashup/jobs -H 'Content-Type: application/json' \
  -d '{"script":"测试文案","material_paths":["/abs/真实视频.mp4"],"api_key":"sk-...","package":{"output_name":"t1","voice":"Cherry"}}'
# → {"code":0,...,"data":{"job_id":"mj_..."}}
curl -s http://127.0.0.1:$PORT/api/mashup/jobs/mj_... | python3 -m json.tool
# 轮询到 status=done，OUTPUTS_DIR 里出现 t1.mp4 + t1.manifest.json
```

```bash
git add backend/routes/mashup.py backend/main.py
git commit -m "feat: mashup job API (single/batch/list/status/cancel/delete)"
```

### Task 2.3 前端 mashup-store（轮询模式，仿 render-store）

**Files:**
- Create: `src/renderer/store/mashup-store.ts`

- [ ] **Step 1: 实现 store**

```typescript
// src/renderer/store/mashup-store.ts
/**
 * Zustand store for mashup jobs: submit / poll / cancel.
 * NOT persisted — jobs live on the backend; loadJobs() restores the list.
 */
import { create } from 'zustand';
import api from '@/renderer/api/backend-client';
import type { TimelineSegment } from '@/renderer/store/editing-store';

export interface MashupJob {
  id: string;
  status: 'pending' | 'processing' | 'done' | 'failed' | 'cancelled';
  progress: number;
  current_step: string;
  created_at: string;
  completed_at: string;
  input: { script: string; material_paths: string[]; stop_after: string;
           package: Record<string, unknown> };
  result: { timeline: TimelineSegment[]; audio_path: string; output_path: string;
            cover_path: string; manifest_path: string };
  error: string;
}

const POLL_MS = 1000;

interface MashupState {
  jobs: MashupJob[];
  submitJob: (payload: Record<string, unknown>) => Promise<string | null>;
  submitBatch: (payload: Record<string, unknown>) => Promise<string[]>;
  loadJobs: () => Promise<void>;
  cancelJob: (id: string) => Promise<void>;
  deleteJob: (id: string) => Promise<void>;
  /** Poll a single job until terminal state; resolves with the final job. */
  waitForJob: (id: string, onUpdate?: (j: MashupJob) => void) => Promise<MashupJob>;
  startListPolling: () => void;
  stopListPolling: () => void;
}

let _listTimer: ReturnType<typeof setInterval> | null = null;

export const useMashupStore = create<MashupState>((set, get) => ({
  jobs: [],

  submitJob: async (payload) => {
    const resp = await api.post<{ job_id: string }>('/api/mashup/jobs', payload);
    if (resp.code !== 0 || !resp.data) throw new Error(resp.message);
    await get().loadJobs();
    return resp.data.job_id;
  },

  submitBatch: async (payload) => {
    const resp = await api.post<{ job_ids: string[] }>('/api/mashup/jobs/batch', payload);
    if (resp.code !== 0 || !resp.data) throw new Error(resp.message);
    await get().loadJobs();
    return resp.data.job_ids;
  },

  loadJobs: async () => {
    const resp = await api.get<{ jobs: MashupJob[] }>('/api/mashup/jobs');
    if (resp.code === 0 && resp.data) set({ jobs: resp.data.jobs });
  },

  cancelJob: async (id) => {
    await api.post(`/api/mashup/jobs/${id}/cancel`);
    await get().loadJobs();
  },

  deleteJob: async (id) => {
    await api.delete(`/api/mashup/jobs/${id}`);
    await get().loadJobs();
  },

  waitForJob: async (id, onUpdate) => {
    for (;;) {
      const resp = await api.get<MashupJob>(`/api/mashup/jobs/${id}`);
      if (resp.code === 0 && resp.data) {
        onUpdate?.(resp.data);
        if (['done', 'failed', 'cancelled'].includes(resp.data.status)) return resp.data;
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  },

  startListPolling: () => {
    if (_listTimer) return;
    _listTimer = setInterval(() => {
      const active = get().jobs.some((j) => j.status === 'pending' || j.status === 'processing');
      if (active) get().loadJobs();
    }, POLL_MS);
  },

  stopListPolling: () => {
    if (_listTimer) { clearInterval(_listTimer); _listTimer = null; }
  },
}));

export default useMashupStore;
```

- [ ] **Step 2: App.tsx 卸载清理接入**

在 `App.tsx` 现有 `beforeunload` cleanup 里追加 `useMashupStore.getState().stopListPolling();`（import 对应 store）。

Run: `npm run typecheck` → 通过。

```bash
git add src/renderer/store/mashup-store.ts src/renderer/App.tsx
git commit -m "feat: mashup job store with backend polling"
```

### Task 2.4 AiScriptEditor 改为提交任务（含批量入口）

**Files:**
- Modify: `src/renderer/components/analysis/AiScriptEditor.tsx`

- [ ] **Step 1: 重写 `handleRun`（生成时间线 = 提交 `stop_after: "timeline"` 任务并等待）**

替换现有 `handleRun` 函数体（保留函数签名与 UI 状态变量）：

```typescript
const buildPackage = () => ({
  output_name: `ai_edit_${Date.now()}`,
  voice,
  speed: speechSpeed,
  width: 1080,
  height: 1920,
  transition: 'none',
  subtitle_style: {
    font: subtitleFont, font_path: subtitleFontPath, color: subtitleColor,
    size: subtitleSize, stroke_color: subtitleStrokeColor, stroke_width: subtitleStrokeWidth,
  },
  subtitle_overrides: subtitleOverrides,
});

const STEP_LABELS: Record<string, string> = {
  queued: '排队中...', material_prepare: '准备素材...', video_analysis: 'AI分析视频画面...',
  script_analysis: 'AI分析文案...', scene_matching: 'AI匹配画面...', tts: '生成口播音轨...',
  composite: '合成视频...', finalize: '写入产物信息...', done: '完成',
};

const handleRun = useCallback(async (): Promise<void> => {
  if (!script.trim()) return;
  if (readyMaterials.length === 0) { setError('请先在步骤1中导入视频素材'); return; }
  setRunning(true); setError(null); setTimeline([]);
  setSteps([{ step: 'job', status: 'running', message: '提交任务...' }]);
  try {
    const jobId = await useMashupStore.getState().submitJob({
      script: script.trim(),
      material_paths: readyMaterials.map((m) => m.filePath).filter(Boolean),
      api_key: apiKey,
      stop_after: 'timeline',
      package: buildPackage(),
    });
    const final = await useMashupStore.getState().waitForJob(jobId!, (j) => {
      setSteps([{ step: 'job', status: 'running',
        message: `${STEP_LABELS[j.current_step] || j.current_step} (${Math.round(j.progress)}%)` }]);
    });
    if (final.status !== 'done') throw new Error(final.error || '任务失败');
    setTimeline(final.result.timeline);
    setSteps([{ step: 'job', status: 'done', message: `时间线已生成 ${final.result.timeline.length} 个片段` }]);
  } catch (err) {
    setError(`执行失败: ${(err as Error).message}`);
    setSteps((prev) => prev.map((s) => ({ ...s, status: 'error' as const })));
  } finally {
    setRunning(false);
  }
}, [script, voice, speechSpeed, apiKey, readyMaterials, subtitleOverrides,
    subtitleFont, subtitleFontPath, subtitleColor, subtitleSize,
    subtitleStrokeColor, subtitleStrokeWidth]);
```

同法重写 `handleRender`：提交 `stop_after: 'full'` + `timeline_override: timeline` 的任务，`waitForJob` 更新进度，完成后 `setOutputPath(final.result.output_path)`。删除组件内所有对 `/api/ai-editing/analyze-script|analyze-video|match-scenes|generate-tts|composite` 的直接调用。

- [ ] **Step 2: 增加批量入口 UI**

在文案输入 Paper 下方新增一个折叠区「批量模式」：一个多行 TextField（`placeholder="每行一条文案，将批量生成多条视频"`，本地 state `batchScripts`）+ 按钮「批量生成 N 条」：

```typescript
const handleBatch = useCallback(async (): Promise<void> => {
  const scripts = batchScripts.split('\n').map((s) => s.trim()).filter(Boolean);
  if (scripts.length === 0) return;
  setError(null);
  try {
    await useMashupStore.getState().submitBatch({
      scripts,
      material_paths: readyMaterials.map((m) => m.filePath).filter(Boolean),
      api_key: apiKey,
      stop_after: 'full',
      package: buildPackage(),
    });
    useMashupStore.getState().startListPolling();
    setSuccessHint(`已提交 ${scripts.length} 个任务，请到步骤 4 查看进度`);
  } catch (err) {
    setError(`批量提交失败: ${(err as Error).message}`);
  }
}, [batchScripts, readyMaterials, apiKey /* + buildPackage 依赖 */]);
```

（`successHint` 为新增本地 state，用现有 Alert 风格展示。）

- [ ] **Step 3: 验证 + 提交**

Run: `npm run typecheck` → 通过。手动：单条流程照常出时间线；批量粘 3 行文案 → 后端 `GET /api/mashup/jobs` 出现 3 个任务。

```bash
git add src/renderer/components/analysis/AiScriptEditor.tsx
git commit -m "feat: AI editor submits mashup jobs; add batch mode"
```

### Task 2.5 步骤 4 改为任务面板（MashupJobList）

**Files:**
- Create: `src/renderer/components/render/MashupJobList.tsx`
- Modify: `src/renderer/components/render/ExportConfirm.tsx`

- [ ] **Step 1: MashupJobList 组件**

职责：挂载时 `loadJobs()` + `startListPolling()`，卸载 `stopListPolling()`；渲染任务卡片列表——每张卡片显示 `output_name / status Chip / LinearProgress(progress) / current_step 中文 / error`；`done` 的卡片提供「预览」（`<video src={backendBase + '/api/ai-editing/video?path=' + encodeURIComponent(output_path)}>`，弹 Dialog）和「复制路径」按钮；`pending/processing` 提供「取消」；终态提供「删除」。样式沿用 MUI Paper/Chip/LinearProgress，参照 `RenderQueue.tsx` 现有卡片风格。核心骨架：

```typescript
const MashupJobList: React.FC = () => {
  const jobs = useMashupStore((s) => s.jobs);
  const { loadJobs, startListPolling, stopListPolling, cancelJob, deleteJob } = useMashupStore.getState();
  const [backendBase, setBackendBase] = useState('');
  const [previewPath, setPreviewPath] = useState<string | null>(null);

  useEffect(() => {
    getBackendBaseUrl().then(setBackendBase);
    loadJobs();
    startListPolling();
    return () => stopListPolling();
  }, []);

  return (
    <Box>
      {jobs.length === 0 && <Typography color="text.secondary">暂无任务</Typography>}
      {jobs.map((j) => (
        <Paper key={j.id} sx={{ p: 2, mb: 1.5 }}>
          {/* 名称 + 状态 Chip + 进度条 + 操作按钮，per spec above */}
        </Paper>
      ))}
      <Dialog open={!!previewPath} onClose={() => setPreviewPath(null)} maxWidth="sm">
        {previewPath && backendBase && (
          <video controls autoPlay style={{ width: '100%' }}
            src={`${backendBase}/api/ai-editing/video?path=${encodeURIComponent(previewPath)}`} />
        )}
      </Dialog>
    </Box>
  );
};
```

- [ ] **Step 2: ExportConfirm 重组**

`ExportConfirm.tsx` 保留顶部「画面比例 / 分辨率」配置区和「开始导出」按钮（内部改为提交 `stop_after:'full' + timeline_override` 任务，宽高来自比例选择），下方嵌入 `<MashupJobList />` 替代原先的单结果预览区。

- [ ] **Step 3: 验证 + 提交**

Run: `npm run typecheck`。手动：批量 3 条任务在面板中并行推进（默认并发 2：两条 processing 一条 pending）；刷新页面后任务列表恢复、进度继续；单条导出流程照常。

```bash
git add src/renderer/components/render/
git commit -m "feat: job panel for batch mashup outputs in export step"
```

**Phase 2 验收**：一次提交 3 条文案 → 3 条成品视频 + 3 份 manifest 落在 OUTPUTS_DIR，互不覆盖；中途刷新前端不影响任务；同素材第二批任务的 video_analysis 步骤秒过（库命中）。

---

## Phase 3：合成统一到 renderer.py 渲染管线

> 本期完成后：混剪任务的合成走 `FFmpegCommandBuilder + RenderEngine`，获得转场、真实帧级进度；`composite_clip` 旧路径保留为回退开关。

### Task 3.1 时间线编译器（TDD）

**Files:**
- Create: `backend/services/timeline_compiler.py`
- Test: `backend/tests/test_timeline_compiler.py`

- [ ] **Step 1: 失败测试**

```python
# backend/tests/test_timeline_compiler.py
from services.timeline_compiler import compile_timeline_to_template


TL = [
    {"segment_index": 0, "segment_text": "a", "video_path": "/v1.mp4", "start_time": 2.0, "duration": 3.0, "reason": ""},
    {"segment_index": 1, "segment_text": "b", "video_path": "/v2.mp4", "start_time": 0.0, "duration": 4.0, "reason": ""},
    {"segment_index": 2, "segment_text": "c", "video_path": "/v1.mp4", "start_time": 8.0, "duration": 2.0, "reason": ""},
]


def test_compile_dedupes_materials():
    template, materials = compile_timeline_to_template(TL, {"transition": "fade"})
    assert len(materials) == 2
    assert {m["file_path"] for m in materials} == {"/v1.mp4", "/v2.mp4"}


def test_compile_segment_fields():
    template, materials = compile_timeline_to_template(TL, {"transition": "fade"})
    segs = template["segments"]
    assert len(segs) == 3
    assert segs[0]["start_time"] == 2.0 and segs[0]["end_time"] == 5.0
    # 中间段有转场，最后一段没有
    assert segs[0]["transition_out"]["type"] == "fade"
    assert segs[-1]["transition_out"]["type"] == "none"
    # material_id 能在 materials 里找到
    ids = {m["id"] for m in materials}
    assert all(s["material_id"] in ids for s in segs)


def test_compile_no_transition():
    template, _ = compile_timeline_to_template(TL, {"transition": "none"})
    assert all(s["transition_out"]["type"] == "none" for s in template["segments"])
```

- [ ] **Step 2: 实现**

```python
# backend/services/timeline_compiler.py
"""Compile an AI mashup timeline into the template format consumed by
services/renderer.py::FFmpegCommandBuilder (segments + materials list)."""


def compile_timeline_to_template(timeline: list[dict], package: dict) -> tuple[dict, list[dict]]:
    trans_type = package.get("transition", "none") or "none"
    materials: list[dict] = []
    path_to_id: dict[str, str] = {}
    segments: list[dict] = []

    for i, seg in enumerate(timeline):
        vp = seg["video_path"]
        if vp not in path_to_id:
            mid = f"m{len(materials)}"
            path_to_id[vp] = mid
            materials.append({"id": mid, "file_path": vp})
        start = float(seg.get("start_time", 0.0))
        dur = float(seg.get("duration", 3.0))
        is_last = i == len(timeline) - 1
        segments.append({
            "id": f"s{i}",
            "material_id": path_to_id[vp],
            "start_time": start,
            "end_time": start + dur,
            "speed": 1.0,
            "transition_out": {
                "type": "none" if is_last else trans_type,
                "duration": 0.3,
            },
        })

    template = {
        "id": "mashup",
        "name": package.get("output_name", "mashup"),
        "segments": segments,
    }
    return template, materials
```

- [ ] **Step 3: 测试通过 + 提交**

Run: `cd backend && venv/bin/python -m pytest tests/test_timeline_compiler.py -v` → PASS。

```bash
git add backend/services/timeline_compiler.py backend/tests/test_timeline_compiler.py
git commit -m "feat: compile mashup timeline to renderer template"
```

### Task 3.2 RenderEngine 支持外部音轨（口播 + 可选 BGM）与自定义输出路径

**Files:**
- Modify: `backend/services/renderer.py`（`FFmpegCommandBuilder`）

- [ ] **Step 1: Builder 支持 `config["narration_audio"]`、`config["bgm"]`、`config["output_path"]`**

改动点（`_build_xfade_command` 与 `_build_filter_complex_concat` 共用，抽一个私有方法）：

1. `_get_output_path()` 开头加：`if self.config.get("output_path"): self._output_path = self.config["output_path"]; return self._output_path`
2. 视频输入之后追加音频输入并记录索引：

```python
def _append_audio_inputs(self, cmd: List[str]) -> tuple[int, int]:
    """Append narration/bgm -i inputs. Returns (narration_idx, bgm_idx); -1 if absent.

    视频输入 = 每 segment 一个 -i（builder 现有行为），所以音频输入索引从 len(self.segments) 起。
    """
    narr = self.config.get("narration_audio", "")
    bgm_cfg = self.config.get("bgm") or {}
    n_idx = b_idx = -1
    next_idx = len(self.segments)
    if narr and os.path.isfile(narr):
        n_idx = next_idx
        next_idx += 1
        cmd.extend(["-i", narr])
    if bgm_cfg.get("file_path") and os.path.isfile(bgm_cfg["file_path"]):
        b_idx = next_idx
        cmd.extend(["-i", bgm_cfg["file_path"]])
    return n_idx, b_idx

def _build_audio_filter(self, n_idx: int, b_idx: int) -> str:
    """Return filter_complex fragment producing [aout], or '' if no external audio."""
    if n_idx < 0:
        return ""
    bgm_cfg = self.config.get("bgm") or {}
    if b_idx < 0:
        return f"[{n_idx}:a]anull[aout]"
    vol = float(bgm_cfg.get("volume", 0.25))
    if bgm_cfg.get("ducking", True):
        return (
            f"[{n_idx}:a]asplit=2[narrA][narrB];"
            f"[{b_idx}:a]volume={vol}[bgmv];"
            f"[bgmv][narrA]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[duck];"
            f"[duck][narrB]amix=inputs=2:duration=first:dropout_transition=0[aout]"
        )
    return (
        f"[{b_idx}:a]volume={vol}[bgmv];"
        f"[bgmv][{n_idx}:a]amix=inputs=2:duration=first:dropout_transition=0[aout]"
    )
```

3. 两个 build 方法里：`n_idx, b_idx = self._append_audio_inputs(cmd)`（在所有 `-i` 素材之后调用）；`audio_f = self._build_audio_filter(n_idx, b_idx)`，非空则并入 `filter_complex`，输出 map 改为：

```python
if audio_f:
    cmd.extend(["-map", "[outv]", "-map", "[aout]", "-c:a", "aac", "-b:a", "192k", "-shortest"])
elif include_audio:
    cmd.extend(["-map", "[outv]", "-map", "0:a?", "-c:a", "aac", "-b:a", "192k", "-shortest"])
else:
    cmd.extend(["-map", "[outv]", "-an"])
```

（注意 `_build_simple_concat` 走 concat demuxer，输入索引模型不同——mashup 路径的分辨率裁切需求本就走 filter_complex；在 `build()` 里加一条：`config` 含 `narration_audio` 时强制走 `_build_filter_complex_concat`/`_build_xfade_command` 分支。）

4. mashup 需要"裁满不留黑边"（竖屏）：`FFmpegCommandBuilder` 现有 scale 是 `decrease+pad`（留黑边）。给 config 加 `"scale_mode": "cover"`，per-segment 链里：

```python
if self.config.get("scale_mode") == "cover":
    chain.append(f"scale={w}:{h}:force_original_aspect_ratio=increase")
    chain.append(f"crop={w}:{h}")
    chain.append("setsar=1")
else:
    # 现有 decrease + pad 两行保持不变
```

- [ ] **Step 2: 验证 sidechaincompress 可用 + 提交**

Run: `backend/venv/bin/python -c "from config import FFMPEG_EXECUTABLE; import subprocess; r=subprocess.run([FFMPEG_EXECUTABLE,'-filters'],capture_output=True,text=True); print('sidechaincompress' in r.stdout, 'xfade' in r.stdout)"`
Expected: `True True`（若 False，改用非 ducking 的 amix 路径并在计划偏差记录里注明）。

```bash
git add backend/services/renderer.py
git commit -m "feat: renderer supports external narration/bgm audio, cover scale, explicit output path"
```

### Task 3.3 MashupQueue 合成步骤切换到统一管线

**Files:**
- Modify: `backend/services/mashup_queue.py`（`_run_composite`）
- Modify: `backend/config.py`（加 `MASHUP_USE_LEGACY_COMPOSITE: bool = os.environ.get("MASHUP_LEGACY_COMPOSITE", "") == "1"`）

- [ ] **Step 1: 替换 `_run_composite`**

```python
async def _run_composite(self, job: dict, timeline: list[dict], audio_path: str) -> str:
    inp = job["input"]
    pkg = inp["package"]
    out_dir = inp.get("output_dir") or str(OUTPUTS_DIR)
    os.makedirs(out_dir, exist_ok=True)
    output_path = os.path.join(out_dir, f"{pkg.get('output_name', job['id'])}.mp4")

    from config import MASHUP_USE_LEGACY_COMPOSITE
    if MASHUP_USE_LEGACY_COMPOSITE:
        # 回退路径：Phase 2 的 composite_clip 实现（保留原代码）
        ...
        return output_path

    from services.timeline_compiler import compile_timeline_to_template
    from services.renderer import RenderEngine

    template, materials = compile_timeline_to_template(timeline, pkg)
    no_sub_path = output_path + ".nosub.mp4"
    config = {
        "output_path": no_sub_path,
        "narration_audio": audio_path,
        "bgm": pkg.get("bgm"),
        "scale_mode": "cover",
        "fps": 30,
        "quality": "medium",
        "include_audio": False,           # 素材原声不要，只用口播/BGM
        "output_format": "mp4",
        "resolution": "custom",
    }
    # 分辨率：builder 的 _get_resolution 不认 custom，直接注入
    config["_custom_resolution"] = {"width": int(pkg.get("width", 1080)),
                                     "height": int(pkg.get("height", 1920))}

    engine = RenderEngine()

    async def on_progress(p: dict) -> None:
        # FFmpeg 真实进度映射到 72-98 区间
        job["progress"] = 72 + (p.get("progress", 0) / 100.0) * 26
        job["current_step"] = "composite"
        self._persist(job["id"])

    result = await engine.render(template, materials, config, job["id"], on_progress)
    if not result.get("success"):
        raise RuntimeError(f"合成失败: {result.get('error')}")

    # 字幕后处理（沿用现有 SRT/ASS 烧录；Phase 4 Task 4.3 换成 ASS 定位版）
    subtitle_style = pkg.get("subtitle_style")
    if subtitle_style:
        from services.video_service import _render_subtitles
        segs = [{"segment_text": t.get("segment_text", ""), "duration": t["duration"]} for t in timeline]
        await asyncio.to_thread(_render_subtitles, no_sub_path, segs, subtitle_style,
                                output_path, int(pkg.get("width", 1080)), int(pkg.get("height", 1920)))
        try:
            os.unlink(no_sub_path)
        except OSError:
            pass
    else:
        os.replace(no_sub_path, output_path)
    return output_path
```

同时在 `renderer.py` 的 `_get_resolution()` 开头加：

```python
custom = self.config.get("_custom_resolution")
if custom:
    return {"width": int(custom["width"]), "height": int(custom["height"])}
```

- [ ] **Step 2: 更新 Task 2.1 的 queue 单测**（`fake_composite` 不受影响，真实路径靠验收）

Run: `cd backend && venv/bin/python -m pytest tests/ -v` → 全 PASS。

- [ ] **Step 3: 验收 + 提交**

手动：提交 `package.transition="fade"` 的任务 → 成品片段之间有淡入淡出；任务进度条在合成阶段平滑推进（不再 72 跳 98）；`MASHUP_LEGACY_COMPOSITE=1` 启动后端可回退旧路径。

```bash
git add backend/services/mashup_queue.py backend/services/renderer.py backend/config.py
git commit -m "feat: mashup composite via unified render pipeline (transitions + real progress)"
```

---

## Phase 4：包装能力补齐（BGM / 封面标题 / 字幕定位）

### Task 4.1 BGM 音乐库与选择

**Files:**
- Modify: `backend/routes/ai_editing.py`（新增 bgm 列表端点）
- Modify: `src/renderer/components/analysis/AiScriptEditor.tsx`（包装配置区加 BGM 选择）
- Modify: `src/renderer/store/editing-store.ts`（加 `bgmPath: string; bgmVolume: number; setBgm...`，随 package 提交）

- [ ] **Step 1: 后端列表端点**

```python
@router.get("/bgm")
async def list_bgm():
    """List user BGM files under BGM_DIR (drop .mp3/.m4a/.wav files there)."""
    from config import BGM_DIR
    exts = {".mp3", ".m4a", ".wav", ".aac", ".flac"}
    files = [
        {"name": p.name, "path": str(p)}
        for p in sorted(BGM_DIR.iterdir())
        if p.is_file() and p.suffix.lower() in exts
    ]
    return _ok({"bgm": files, "dir": str(BGM_DIR)})
```

- [ ] **Step 2: 前端**：editing-store 增加 `bgmPath`（''=不用）、`bgmVolume`（默认 0.25），persist；AiScriptEditor 包装区加一个 Select（选项来自 `/api/ai-editing/bgm`，含"无 BGM"）+ 音量 Slider + 「打开音乐文件夹」提示文案（显示 `data.dir` 路径）；`buildPackage()` 里加 `bgm: bgmPath ? { file_path: bgmPath, volume: bgmVolume, ducking: true } : null`。

- [ ] **Step 3: 验收 + 提交**

放一个 mp3 到 BGM_DIR，选中后出片：BGM 铺底且口播时音乐明显压低（ducking 生效）。

```bash
git add backend/routes/ai_editing.py src/renderer/store/editing-store.ts src/renderer/components/analysis/AiScriptEditor.tsx
git commit -m "feat: BGM library, selection UI, ducked mixing into output"
```

### Task 4.2 封面与标题贴片

**Files:**
- Create: `backend/services/cover_service.py`
- Modify: `backend/services/mashup_queue.py`（finalize 前生成封面/片头）
- Modify: `src/renderer/components/analysis/AiScriptEditor.tsx`（包装区加：标题文字输入、片头时长 0/1/2s 选择）

- [ ] **Step 1: cover_service 实现**

```python
# backend/services/cover_service.py
"""Cover image + optional intro card generation.

cover config schema: §1.3 package.cover
"""
import os
import subprocess
from config import FFMPEG_EXECUTABLE
from services.renderer import _escape_drawtext


def _ffmpeg() -> str:
    return FFMPEG_EXECUTABLE if os.path.exists(FFMPEG_EXECUTABLE) else "ffmpeg"


def _title_filter(cover_cfg: dict, w: int, h: int) -> str:
    title = (cover_cfg.get("title_text") or "").strip()
    if not title:
        return ""
    size = int(cover_cfg.get("title_size", 72))
    color = cover_cfg.get("title_color", "#ffffff")
    font_path = cover_cfg.get("font_path", "")
    font_part = f":fontfile='{font_path}'" if font_path and os.path.exists(font_path) else ""
    return (f",drawtext=text='{_escape_drawtext(title)}':fontsize={size}:fontcolor={color}"
            f":x=(w-text_w)/2:y=(h-text_h)/2:borderw=4:bordercolor=black{font_part}")


def generate_cover(video_path: str, cover_cfg: dict, out_jpg: str, w: int, h: int) -> str:
    """Export cover jpg: from image_path or the video's first frame, with optional title text."""
    src_image = cover_cfg.get("image_path", "")
    vf = f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h}{_title_filter(cover_cfg, w, h)}"
    if src_image and os.path.exists(src_image):
        cmd = [_ffmpeg(), "-i", src_image, "-vf", vf, "-frames:v", "1", "-q:v", "2", "-y", out_jpg]
    else:
        cmd = [_ffmpeg(), "-ss", "0.5", "-i", video_path, "-vf", vf,
               "-frames:v", "1", "-q:v", "2", "-y", out_jpg]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if r.returncode != 0 or not os.path.exists(out_jpg):
        raise RuntimeError(f"封面生成失败: {r.stderr[-300:]}")
    return out_jpg


def generate_intro_clip(cover_jpg: str, duration: float, out_mp4: str, w: int, h: int, fps: int = 30) -> str:
    """Render a still intro card video from the cover image."""
    cmd = [_ffmpeg(), "-loop", "1", "-i", cover_jpg, "-t", str(duration),
           "-vf", f"scale={w}:{h},setsar=1,fps={fps}", "-c:v", "libx264",
           "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p", "-an", "-y", out_mp4]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    if r.returncode != 0 or not os.path.exists(out_mp4):
        raise RuntimeError(f"片头生成失败: {r.stderr[-300:]}")
    return out_mp4
```

- [ ] **Step 2: mashup_queue 接线**

`_run_composite` 返回后、写 manifest 前：

```python
cover_cfg = pkg.get("cover") or None
if cover_cfg:
    from services.cover_service import generate_cover, generate_intro_clip
    w, h = int(pkg.get("width", 1080)), int(pkg.get("height", 1920))
    cover_jpg = os.path.splitext(output_path)[0] + "_cover.jpg"
    await asyncio.to_thread(generate_cover, output_path, cover_cfg, cover_jpg, w, h)
    job["result"]["cover_path"] = cover_jpg
    intro_sec = float(cover_cfg.get("intro_duration", 0))
    if intro_sec > 0:
        intro_mp4 = os.path.splitext(output_path)[0] + "_intro.mp4"
        await asyncio.to_thread(generate_intro_clip, cover_jpg, intro_sec, intro_mp4, w, h)
        # 片头 + 正片 concat（正片音轨保留，片头静音补齐）
        merged = os.path.splitext(output_path)[0] + "_final.mp4"
        concat_txt = os.path.splitext(output_path)[0] + "_concat.txt"
        Path(concat_txt).write_text(f"file '{intro_mp4}'\nfile '{output_path}'\n")
        proc = await asyncio.to_thread(
            __import__("subprocess").run,
            [_ffmpeg_bin(), "-f", "concat", "-safe", "0", "-i", concat_txt,
             "-c:v", "libx264", "-preset", "fast", "-crf", "21",
             "-c:a", "aac", "-b:a", "192k", "-y", merged],
            capture_output=True, text=True, timeout=300)
        if proc.returncode == 0 and os.path.exists(merged):
            os.replace(merged, output_path)
        for f in (intro_mp4, concat_txt):
            try: os.unlink(f)
            except OSError: pass
```

（文件顶部加 `def _ffmpeg_bin(): from services.video_service import _ffmpeg; return _ffmpeg()`。注意：片头无音轨，concat 后若音频错位则改为对片头 `-f lavfi -i anullsrc` 补静音轨——验收时确认。）

- [ ] **Step 3: 前端**：AiScriptEditor 包装区加「标题文字」TextField 与「片头贴片」Select（无/1秒/2秒）；`buildPackage()` 加 `cover: coverTitle ? { mode: 'first_frame', title_text: coverTitle, title_size: 72, title_color: '#ffffff', intro_duration: introSec } : null`（editing-store 加 `coverTitle`、`introSec` 并 persist）。

- [ ] **Step 4: 验收 + 提交**

出片后目录里有 `xxx_cover.jpg`（带标题字）；intro_duration=1 时成品前 1 秒是封面卡；manifest 的 `output.cover` 指向封面。

```bash
git add backend/services/cover_service.py backend/services/mashup_queue.py \
  src/renderer/store/editing-store.ts src/renderer/components/analysis/AiScriptEditor.tsx
git commit -m "feat: cover image export and intro title card"
```

### Task 4.3 字幕定位真正落地（SRT → ASS，支持逐段 x/y；修死 Windows 字体路径）

**Files:**
- Create: `backend/services/subtitle_service.py`
- Modify: `backend/services/video_service.py`（`_render_subtitles` 改为调用新服务）
- Test: `backend/tests/test_subtitle_service.py`

- [ ] **Step 1: 失败测试**

```python
# backend/tests/test_subtitle_service.py
from services.subtitle_service import build_ass, resolve_font


def test_build_ass_basic():
    segs = [{"segment_text": "第一句", "duration": 2.0},
            {"segment_text": "", "duration": 1.0},
            {"segment_text": "第三句", "duration": 3.0}]
    ass = build_ass(segs, {"size": 24, "color": "#ffffff", "stroke_color": "#000000",
                            "stroke_width": 2, "font": "PingFang SC"}, {}, 1080, 1920)
    assert "[Events]" in ass
    assert ass.count("Dialogue:") == 2          # 空文本不产字幕
    assert "0:00:00.00" in ass and "0:00:03.00" in ass  # 第三句从 3.0s 开始


def test_build_ass_position_override():
    segs = [{"segment_text": "顶部字", "duration": 2.0}]
    ass = build_ass(segs, {"size": 24, "color": "#ffffff", "stroke_color": "#000000",
                            "stroke_width": 2, "font": "PingFang SC"},
                    {0: {"x": 50, "y": 10}}, 1080, 1920)
    assert r"{\pos(540,192)}" in ass


def test_resolve_font_returns_existing_path():
    path = resolve_font("")
    assert path == "" or __import__("os").path.exists(path)
```

- [ ] **Step 2: 实现**

```python
# backend/services/subtitle_service.py
"""ASS subtitle builder with per-segment position overrides.

overrides: {segment_index: {"text"?: str, "x"?: pct, "y"?: pct}} — x/y 为画面百分比。
"""
import os
import platform


_PLATFORM_FONTS = {
    "Darwin": ["/System/Library/Fonts/PingFang.ttc",
                "/System/Library/Fonts/STHeiti Medium.ttc",
                "/System/Library/Fonts/Hiragino Sans GB.ttc"],
    "Windows": ["C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/simhei.ttf"],
    "Linux": ["/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
               "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc"],
}


def resolve_font(preferred_path: str) -> str:
    """Return an existing font file path, preferring the user's choice."""
    if preferred_path and os.path.exists(preferred_path):
        return preferred_path
    for cand in _PLATFORM_FONTS.get(platform.system(), []):
        if os.path.exists(cand):
            return cand
    return ""


def _ass_time(sec: float) -> str:
    h = int(sec // 3600)
    m = int(sec % 3600 // 60)
    s = sec % 60
    return f"{h}:{m:02d}:{s:05.2f}"


def _bgr(hex_color: str) -> str:
    c = hex_color.lstrip("#")
    return f"{c[4:6]}{c[2:4]}{c[0:2]}" if len(c) == 6 else "FFFFFF"


def build_ass(segments: list[dict], style: dict, overrides: dict, w: int, h: int) -> str:
    font = style.get("font", "PingFang SC")
    size = int(style.get("size", 24))
    header = (
        "[Script Info]\nScriptType: v4.00+\n"
        f"PlayResX: {w}\nPlayResY: {h}\n\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, "
        "Bold, Italic, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
        f"Style: Default,{font},{size},&H00{_bgr(style.get('color', '#ffffff'))},"
        f"&H00{_bgr(style.get('stroke_color', '#000000'))},&H80000000,0,0,"
        f"{int(style.get('stroke_width', 2))},0,2,20,20,{int(h * 0.06)},1\n\n"
        "[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )
    lines = [header]
    acc = 0.0
    for i, seg in enumerate(segments):
        dur = float(seg.get("duration", 2.0))
        ov = overrides.get(i) or overrides.get(str(i)) or {}
        text = (ov.get("text") if ov.get("text") is not None else seg.get("segment_text") or "").strip()
        if text:
            pos = ""
            if ov.get("x") is not None and ov.get("y") is not None:
                px = int(float(ov["x"]) * w / 100)
                py = int(float(ov["y"]) * h / 100)
                pos = r"{\pos(%d,%d)}" % (px, py)
            text = text.replace("\n", r"\N")
            lines.append(f"Dialogue: 0,{_ass_time(acc)},{_ass_time(acc + dur)},Default,,0,0,0,,{pos}{text}")
        acc += dur
    return "\n".join(lines) + "\n"
```

- [ ] **Step 3: `_render_subtitles` 改造**

`video_service.py::_render_subtitles` 内部：删掉 SRT 生成与 force_style 逻辑，改为——`build_ass(segments, style, style.get("overrides", {}), w, h)` 写到 `subs.ass`；字体经 `resolve_font(style.get("font_path",""))`，`fontsdir` 用其所在目录：

```python
ass_escaped = ass_path.replace("\\", "/").replace(":", "\\:")
font_path = resolve_font(style.get("font_path", ""))
fontsdir_part = f":fontsdir='{os.path.dirname(font_path)}'" if font_path else ""
cmd = [_ffmpeg(), "-i", video_path,
       "-vf", f"subtitles='{ass_escaped}'{fontsdir_part}",
       "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
       "-c:a", "copy", "-y", output_path]
```

调用侧（`mashup_queue._run_composite` 的字幕后处理）把 `pkg["subtitle_overrides"]` 塞进 `subtitle_style["overrides"]` 传入。

- [ ] **Step 4: 测试 + 验收 + 提交**

Run: `cd backend && venv/bin/python -m pytest tests/test_subtitle_service.py -v` → PASS。
手动：步骤 3 里把某段字幕拖到画面上方 → 出片后该段字幕确实在上方；macOS 上中文字幕正常渲染（不再依赖 Windows 字体路径）。

```bash
git add backend/services/subtitle_service.py backend/services/video_service.py backend/tests/test_subtitle_service.py
git commit -m "feat: ASS subtitles with per-segment positioning and cross-platform fonts"
```

---

## Phase 5：程序化对接（上游流水线入口）

### Task 5.1 固定端口 / headless 启动

**Files:**
- Modify: `backend/main.py`（`__main__` 块）

- [ ] **Step 1: argparse**

```python
if __name__ == "__main__":
    import argparse
    import uvicorn

    parser = argparse.ArgumentParser(description="短视频混剪后端")
    parser.add_argument("--port", type=int, default=0, help="固定端口（0=自动在 18000-18999 内选）")
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()

    port = args.port or find_available_port(PORT_RANGE_START, PORT_RANGE_END)
    print(f"PORT:{port}", flush=True)
    uvicorn.run("main:app", host=args.host, port=port, reload=False, log_level="info")
```

（Electron 不传参 → 行为完全不变。）

- [ ] **Step 2: 验证 + 提交**

Run: `cd backend && venv/bin/python main.py --port 18500 &` → `curl http://127.0.0.1:18500/api/health` 返回 `code:0`；kill 掉。

```bash
git add backend/main.py
git commit -m "feat: --port/--host flags for headless fixed-port operation"
```

### Task 5.2 任务包 API（/api/pipeline/submit）+ 可选 token 鉴权

**Files:**
- Create: `backend/routes/pipeline.py`
- Modify: `backend/main.py`（注册 router + 鉴权中间件）

- [ ] **Step 1: 契约与实现**

请求（上游项目产出的任务包）：

```json
POST /api/pipeline/submit
{
  "task_id": "upstream-batch-001",
  "materials": ["/abs/a.mp4", "/abs/b.mp4"],
  "jobs": [
    {"script": "文案一……"},
    {"script": "文案二……", "package": {"voice": "Ethan"}}
  ],
  "package": {"voice": "Cherry", "width": 1080, "height": 1920, "transition": "fade",
               "bgm": {"file_path": "/abs/music.mp3", "volume": 0.25, "ducking": true}},
  "api_key": "sk-...",
  "output_dir": "/abs/finished",
  "callback_url": "http://127.0.0.1:9000/on-video-done"
}
→ {"code":0,"data":{"task_id":"upstream-batch-001","job_ids":["mj_x","mj_y"]}}
```

```python
# backend/routes/pipeline.py
"""Upstream pipeline entry: submit a task package → N mashup jobs.

任务包契约见 docs/plans/2026-07-04-pipeline-evolution.md §Task 5.2。
每个 job 完成/失败时，若 callback_url 非空会 POST 回执（见 MashupQueue._fire_callback）。
"""
import os
import uuid
from fastapi import APIRouter

from services.mashup_queue import get_mashup_queue

router = APIRouter(prefix="/api/pipeline", tags=["pipeline"])


def _ok(data=None, msg="success"):
    return {"code": 0, "message": msg, "data": data}


def _err(code: int, msg: str):
    return {"code": code, "message": msg, "data": None}


@router.post("/submit")
async def submit_task(payload: dict):
    materials = payload.get("materials", [])
    jobs = payload.get("jobs", [])
    if not materials:
        return _err(40001, "缺少 materials")
    if not jobs:
        return _err(40001, "缺少 jobs")
    missing = [p for p in materials if not os.path.exists(p)]
    if missing:
        return _err(40004, f"素材不存在: {missing[:3]}")
    output_dir = payload.get("output_dir", "")
    if output_dir and not os.path.isdir(output_dir):
        return _err(40010, f"output_dir 不存在: {output_dir}")

    task_id = payload.get("task_id") or "pt_" + uuid.uuid4().hex[:8]
    base_pkg = payload.get("package", {})
    queue = get_mashup_queue()
    job_ids = []
    for i, j in enumerate(jobs):
        if not j.get("script", "").strip():
            return _err(40001, f"jobs[{i}] 缺少 script")
        pkg = {**base_pkg, **j.get("package", {})}
        pkg.setdefault("output_name", f"{task_id}_{i + 1:02d}")
        job = queue.create_job({
            "script": j["script"],
            "material_paths": materials,
            "api_key": payload.get("api_key", ""),
            "stop_after": "full",
            "output_dir": output_dir,
            "callback_url": payload.get("callback_url", ""),
            "external_task_id": task_id,
            "package": pkg,
        })
        job_ids.append(job["id"])
    return _ok({"task_id": task_id, "job_ids": job_ids}, f"已创建 {len(job_ids)} 个任务")


@router.get("/tasks/{task_id}")
async def get_task(task_id: str):
    jobs = [j for j in get_mashup_queue().list_jobs()
            if j["input"].get("external_task_id") == task_id]
    if not jobs:
        return _err(40004, f"任务包不存在: {task_id}")
    done = sum(1 for j in jobs if j["status"] == "done")
    failed = sum(1 for j in jobs if j["status"] in ("failed", "cancelled"))
    return _ok({
        "task_id": task_id,
        "total": len(jobs), "done": done, "failed": failed,
        "all_finished": done + failed == len(jobs),
        "jobs": [{"id": j["id"], "status": j["status"], "progress": j["progress"],
                   "output_path": j["result"].get("output_path", ""),
                   "manifest_path": j["result"].get("manifest_path", ""),
                   "error": j["error"]} for j in jobs],
    })
```

`main.py` 注册 router，并加可选鉴权中间件（在 CORS 中间件之后）：

```python
import os as _os
from fastapi.responses import JSONResponse

@app.middleware("http")
async def pipeline_auth(request, call_next):
    token = _os.environ.get("MASHUP_API_TOKEN", "")
    if token and request.url.path.startswith("/api/pipeline"):
        if request.headers.get("authorization", "") != f"Bearer {token}":
            return JSONResponse({"code": 40100, "message": "unauthorized", "data": None},
                                status_code=401)
    return await call_next(request)
```

另外：`output_dir` 是队列写出去的目录，为了成品能被 `/api/ai-editing/video` 预览，`mashup_queue._run_composite` 里当使用自定义 `output_dir` 时对 `output_path` 调一次 `register_material_path(output_path)`。

- [ ] **Step 2: 端到端验收 + 提交**

不开 Electron，纯命令行：

```bash
cd backend && venv/bin/python main.py --port 18500 &
curl -s -X POST http://127.0.0.1:18500/api/pipeline/submit -H 'Content-Type: application/json' -d '{
  "materials": ["/abs/真实素材1.mp4", "/abs/真实素材2.mp4"],
  "jobs": [{"script": "文案一……"}, {"script": "文案二……"}],
  "package": {"voice": "Cherry", "transition": "fade"},
  "api_key": "sk-...",
  "output_dir": "/abs/finished"
}'
# 轮询 /api/pipeline/tasks/{task_id} 直到 all_finished=true
# 验证 /abs/finished 下有 2 个 mp4 + 2 个 manifest.json
```

```bash
git add backend/routes/pipeline.py backend/main.py backend/services/mashup_queue.py
git commit -m "feat: pipeline task-package API with aggregate status and optional token auth"
```

### Task 5.3（可选）监听目录模式

**Files:**
- Modify: `backend/main.py`（`--watch-dir` 参数 + lifespan 里起监视任务）

- [ ] **Step 1: 实现**

argparse 加 `--watch-dir`，存到环境变量 `MASHUP_WATCH_DIR` 再启动 uvicorn（因为 uvicorn 以字符串 import app）；`lifespan` 里：

```python
import asyncio as _asyncio

async def _watch_dir_loop():
    import json as _json
    watch = os.environ.get("MASHUP_WATCH_DIR", "")
    if not watch or not os.path.isdir(watch):
        return
    from routes.pipeline import submit_task
    while True:
        for name in sorted(os.listdir(watch)):
            if not name.endswith(".task.json"):
                continue
            fp = os.path.join(watch, name)
            try:
                payload = _json.loads(open(fp, encoding="utf-8").read())
                result = await submit_task(payload)
                suffix = ".done.json" if result["code"] == 0 else ".failed.json"
            except Exception:
                suffix = ".failed.json"
            os.replace(fp, fp.replace(".task.json", suffix))
        await _asyncio.sleep(3)

# lifespan 的 yield 之前：
watch_task = asyncio.create_task(_watch_dir_loop())
# yield 之后（关闭时）：
watch_task.cancel()
```

- [ ] **Step 2: 验收 + 提交**

`python main.py --port 18500 --watch-dir /abs/inbox`，往 inbox 丢一个 `batch01.task.json`（内容 = Task 5.2 的请求体）→ 数秒内被改名为 `.done.json`，任务开始跑。

```bash
git add backend/main.py
git commit -m "feat: optional watch-dir mode for file-based task submission"
```

---

## 风险与注意事项（实现时对照检查）

1. **事件循环**：所有新增 subprocess/FFmpeg/文件大 IO 调用，只要在 async 上下文里就必须 `asyncio.to_thread`。MashupQueue 的 worker 是 asyncio task，同样适用。
2. **路径安全**：新增的可服务目录（OUTPUTS_DIR、LIBRARY_DIR、BGM_DIR、自定义 output_dir 的成品）都要经 `_is_safe_path` 白名单或 `register_material_path` 登记，Phase 0 Task 0.3 已覆盖前三者。
3. **LLM 并发与费用**：`ai_service.py` 的 vision 信号量是模块级（默认 5），多任务并发时全局共享——这是刻意的，不要改成每任务一个信号量，否则批量任务会打爆限流。
4. **FFmpeg 滤镜可用性**：`sidechaincompress`、`xfade` 依赖完整版 FFmpeg；Task 3.2 Step 2 有探测命令，探测失败要降级（非 ducking amix / 无转场）并记录。
5. **取消语义**：Phase 2 里取消只在步骤边界生效（合成中的 FFmpeg 不中断）；Phase 3 接入 RenderEngine 后可扩展为实时取消（调 `engine.cancel()`），不作为验收硬指标。
6. **IPC 超时**：前端所有会 >30s 的调用（导出、等待任务不算——轮询是短请求）记得传 `timeout`；轮询类请求保持默认 30s。
7. **旧端点的去留**：Phase 2 完成后 `/api/ai-editing/composite`、`/full-pipeline` 前端不再使用，但**保留端点**（Phase 5 之前上游可能已有人试用）；在 Phase 5 验收后于 CLAUDE.md 标注 deprecated。
8. **schema_version**：素材资产与 manifest 均带 `schema_version: 1`；后续字段变更必须递增并做读取兼容。

## 每期统一验收（Phase 收尾必跑）

```bash
npm run typecheck                                        # 前端类型
cd backend && venv/bin/python -m pytest tests/ -v        # 后端单测全绿
# 后端可启动、健康检查通过：
venv/bin/python main.py & sleep 3 && curl -s http://127.0.0.1:$(grep -o 'PORT:[0-9]*' <日志> | cut -d: -f2)/api/health
# 再跑本期各 Task 的手动验收项
```

## 计划外偏差记录

执行过程中与本计划不一致的决策（接口改名、降级方案、跳过的可选项）记录在本节，供后续接手者对照：

- （执行时填写）
