# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

短视频智能混剪工具 (Short Video Mashup Tool) — an Electron desktop app for AI-driven short video editing. Two-process architecture: an Electron app (Node/TS main process + React renderer) drives a local Python FastAPI backend that does the actual video/AI work (FFmpeg, OpenCV, LLM calls).

## Development commands

Frontend / Electron (run from repo root):

```
npm run dev            # Vite dev server only (renderer), port 5173
npm run typecheck      # tsc --noEmit for both renderer and main/preload configs
npm run build           # typecheck + compile main/preload (tsc) + vite build (renderer)
npm run electron:dev    # compile main/preload + build renderer, then launch Electron
npm run electron:build  # full build + package via electron-builder -> release/
npm run preview         # preview the built renderer bundle
npm run test:runtime    # scripts/verify-runtime-config.mjs — see below
```

`test:runtime` sanity-checks a *production* build: it asserts `dist-electron/main/{index,constants}.js` exist, then imports the compiled constants to resolve the Python executable and asserts the resolved FFmpeg/FFprobe binaries exist, are executable, and run `-version` successfully. Requires `npm run build` to have already run and `backend/venv` to already be provisioned.

Fastest way to run the whole app during development: `./start.command` (macOS). It auto-installs npm deps (`--ignore-scripts`) if missing, creates and provisions `backend/venv` if missing, starts the Python backend (logs to `/tmp/short-video-mashup-backend.log`), polls `/api/health` until ready, launches `npx vite --host`, and opens the browser at `http://localhost:5173?backend_port=<port>`. Ctrl+C tears down both child processes.

Backend (Python), manual setup:

```
python3 -m venv backend/venv
backend/venv/bin/pip install -r backend/requirements.txt python-multipart httpx
backend/venv/bin/python backend/main.py
```

`python-multipart` (used by the materials upload endpoint) and `httpx` (used by `services/ai_service.py`) are real runtime dependencies but are **not listed** in `backend/requirements.txt` — always install them alongside `-r requirements.txt`, the way `start.command` does. Backend modules use paths relative to `backend/`, so run Python commands with `cwd=backend/`.

There is no test framework configured anywhere in this repo (no jest/vitest/pytest config, no test files). Don't assume one exists when asked to "run the tests."

## Architecture

### Process model & communication

- Electron **main process** (`src/main/`) spawns the Python backend as a child process and owns its lifecycle.
- The backend picks a free port from 18000–18999, prints `PORT:<port>` on stdout, and serves FastAPI via uvicorn on `127.0.0.1`. The main process parses that line to learn the port (`src/main/python-bridge.ts`).
- In packaged/Electron mode, the **renderer never talks HTTP directly to the backend** — it calls `window.electronAPI.backendRequest(...)` (IPC) and the main process proxies the HTTP call (`ipc-handlers.ts`, channel `backend:request`). This sidesteps CORS/mixed-content issues in production.
- In plain-browser dev mode (no Electron), `src/renderer/api/backend-client.ts` falls back to direct `fetch('http://127.0.0.1:<port>/...')`, discovering the port from `window.__BACKEND_PORT__`, the `?backend_port=` query param, or a default of 18000. This dual-mode is why `start.command` opens the browser with `?backend_port=` — the app is usable both inside and outside Electron.
- Every backend response uses the same envelope: `{ code: number, message: string, data: T | null }` (`code === 0` is success; see `backend/config.py::ErrorCode` for the 40xxx client-error / 50xxx server-error ranges).

### Electron main process (`src/main/`)

- `index.ts` — app entry: creates the `BrowserWindow`, starts/stops `PythonBridge`, forwards backend status to the renderer over the `backend:status-changed` IPC channel.
- `python-bridge.ts` — `PythonBridge` class owns the Python child process: parses the port from stdout, polls `/api/health` until healthy (30s timeout), heartbeats every 10s, and **auto-restarts on crash or 3 consecutive heartbeat failures** with exponential backoff (1s → 2s → 4s ... capped at 30s, max 5 attempts) before giving up and surfacing an `error` status. Graceful shutdown is SIGTERM then SIGKILL after 5s.
- `ipc-handlers.ts` — registers the dialog (folder/file picker), platform-info, backend HTTP proxy, and temp-cleanup IPC handlers.
- `constants.ts` — resolves the Python executable (checks `MASHUP_PYTHON`/`PYTHON_EXECUTABLE` env vars, then `backend/venv/bin/python[3]`, then falls back to system `python3`/`python`), plus all IPC channel names and restart/health-check timing constants.

### Preload (`src/preload/index.ts`)

Exposes a minimal `window.electronAPI` via `contextBridge` (`contextIsolation: true`, `nodeIntegration: false`): `selectFolder`, `selectFile`, `getPythonPort`, `getPlatform`, `backendRequest`, `cleanTemp`. No raw Node/Electron API reaches the renderer.

### Renderer (`src/renderer/`)

React 18 + MUI + Zustand, built with Vite (`@` path alias → `src/`).

- `App.tsx` — a 4-step wizard (导入素材 → AI智能创作 → 预览调整 → 导出渲染). All steps stay mounted simultaneously (visibility toggled via `display: none`) so component state survives step navigation. `canNavigateTo()` gates forward navigation: blocked while any long-running op is active (`editingRunning || isBatchRunning || isRendering`), blocked into step 1 without materials, blocked into step 3 without a generated timeline.
- `store/` — one Zustand store per domain, deliberately split on what should survive a reload:
  - `materials-store.ts`, `editing-store.ts` — use the `persist` middleware (localStorage), since losing imported materials or an in-progress script/timeline on refresh is bad UX. Ephemeral UI fields (`selectedIds`, `running`, etc.) are excluded via `partialize`.
  - `analysis-store.ts`, `render-store.ts` — **not** persisted (except render presets, saved manually to a separate `mashup_render_presets` localStorage key). These hold in-flight polling state tied to a live backend process; persisting them would resurrect stale "processing" jobs after a reload. Analysis polls `/api/analysis/status/{id}` every 800ms (300 attempt cap ≈ 4 min); render polls `/api/render/status/{jobId}` every 500ms. Both stores expose `stopAllPolling()`, called from `App.tsx`'s `beforeunload` handler — when adding new polling loops, wire cleanup the same way.
  - `template-store.ts` — template CRUD + segment editing + undo/redo history.
- `api/backend-client.ts` — the `apiRequest`/`api.{get,post,put,patch,delete}` helpers described above.

### Backend (`backend/`)

FastAPI app, single uvicorn worker, entry point `main.py`.

- `config.py` — central config: per-OS app-data paths, FFmpeg/FFprobe executable resolution (checks env var → bundled `resources/ffmpeg/` → `node_modules/{ffmpeg,ffprobe}-static` → system `PATH`, verifying each candidate actually runs `-version` before accepting it), render defaults, AI provider config (`AI_API_BASE_URL`/`AI_API_KEY`/model names, all env-overridable; the API key can also be supplied per-request from the renderer instead of via env var).
- `routes/materials.py` — validate / ffprobe-metadata / browser-mode upload / thumbnail generation.
- `routes/analysis.py` — smart material analysis. Submits work to a **bounded** `ThreadPoolExecutor` (size = `ANALYSIS_MAX_CONCURRENT`, default 3) instead of spawning unbounded threads; results live in an in-memory dict polled via `/status/{id}` and `/result/{id}`.
- `routes/templates.py` — template CRUD, persisted as JSON files under the per-OS templates dir; builtin presets are seeded by `services/templates_builtin.py` on first access.
- `routes/render.py` — render job submission/status/cancel/download, delegating to the `RenderQueue` singleton in `services/renderer.py`.
- `routes/ai_editing.py` — the AI voiceover pipeline: script → semantic segments → per-video scene detection + vision description → segment/scene matching → TTS → final composite (see `/full-pipeline` for the orchestrated version of the individual endpoints). Also serves generated preview media (`/video`, `/audio`, `/thumb`, all gated by `_is_safe_path()`).
- `services/analyzer.py` — `AnalysisEngine`: histogram-distance scene detection (OpenCV primary, ffmpeg-frame-extraction + PIL fallback when `cv2` is unavailable), quality scoring (brightness/contrast/sharpness/stability, weighted), heuristic tag generation, highlight detection (scene-change intensity + color richness).
- `services/video_service.py` — ffmpeg-filter-based scene detection and segment compositing (trim → concat → mux TTS audio → optional SRT subtitle burn-in).
- `services/renderer.py` — `FFmpegCommandBuilder` (picks concat / filter_complex / xfade / GIF command strategy based on which features a template uses) + `RenderEngine` (async subprocess exec with stderr progress parsing, 30-minute timeout) + `RenderQueue` (single-worker asyncio queue; jobs persisted as JSON under `backend/data/renders/`; on restart, any job still marked "processing" is flipped to "failed" since it was orphaned by the crash).
- `services/ai_service.py` — httpx client for an OpenAI-compatible API: TTS (`/audio/speech`), vision frame description and text-based script/scene-matching (`/chat/completions`, expects the model to return JSON, handled by `_extract_json_from_content`). All external calls go through `_retry_with_backoff` (retries 429/502/503/504 and network errors, exponential backoff, max 3 retries). Batch frame analysis uses `asyncio.gather` + a `Semaphore(5)` for bounded concurrency instead of a serial loop.

### Cross-cutting conventions to preserve

- **Never block the event loop.** Any CPU-bound or subprocess-blocking call (scene detection, frame extraction, ffmpeg/ffprobe invocations) reached from an `async def` route must go through `asyncio.to_thread(...)`. A single un-wrapped blocking call in one route previously stalled *all* API traffic, including the frontend's status polling — keep new blocking work off the event loop.
- **Path safety for file-serving endpoints.** Anything that serves a file from disk by path must reuse the `_is_safe_path()` / `register_material_path()` pattern in `routes/ai_editing.py` (realpath resolution + media-extension allowlist + must resolve under `TEMP_DIR` or a previously-registered material path). Don't trust a client-supplied path directly.
- **FFmpeg text escaping.** Any text going into a `drawtext`/`subtitles` filter must pass through `_escape_drawtext()` (`services/renderer.py`) — unescaped `:`, `%`, `{`, `}`, `'`, `\` breaks the filter graph syntax.
- **Backend resilience is intentional.** `PythonBridge` restarts the backend automatically and reports `starting`/`running`/`reconnecting`/`error` status to the renderer. Don't add new failure paths that swallow errors silently in that lifecycle — surface them through `onStatusChange` so the UI can reflect reconnection state.
- **Store persistence is a deliberate split**, not an oversight (see renderer store notes above) — think before adding `persist()` to a store that tracks a live backend job.

### Active roadmap

`docs/plans/2026-07-04-pipeline-evolution.md` is the in-progress plan to evolve this tool into a batch-production pipeline node (material-library analysis cache, mashup job queue, unified render pipeline, BGM/cover/subtitle packaging, upstream task-package API). It locks shared schemas (asset/job/manifest) and API contracts — consult it before adding features in those areas, and record any deviations in its 计划外偏差记录 section.

### Packaging note

`electron-builder.yml` expects a pre-built, frozen Python backend at `backend/dist/` (bundled as an `extraResource`) plus `resources/ffmpeg/` binaries — neither is produced by anything in this repo currently (no PyInstaller spec or backend-build script exists yet). `npm run electron:build` will package fine but the resulting artifact won't have a working bundled backend until that build step is added.
