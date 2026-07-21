# AGENTS.md

Project: **short-video-mashup-tool** — AI-driven short video mashup desktop app.
Active code lives in `short-video-mashup-tool/` (not repo root).
Backup reference: `ai-remix-new/AI-remix-main/` (older snapshot, do not edit).

## Architecture

Electron 28 (Node/TS main + React renderer) spawns a Python FastAPI backend as a child process.
Backend picks a free port 18000–18999, prints `PORT:<n>` to stdout, serves on `127.0.0.1`.
Renderer talks to backend via Electron IPC proxy (`window.electronAPI.backendRequest`) in packaged mode,
or direct `fetch` in browser dev mode.

All API responses: `{ code: 0, message: "...", data: ... }` (`code === 0` = success).

## Quick dev

```bash
# Frontend only (browser mode, HMR)
cd short-video-mashup-tool
npm run dev                           # Vite dev server on 5173

# Backend only
cd short-video-mashup-tool/backend
python main.py                        # auto-picks free port, writes .dev-port

# Full Electron app
npm run electron:dev                  # compiles main/preload + builds renderer + launches Electron

# Typecheck
npm run typecheck                     # tsc --noEmit (renderer config only! does NOT check main/preload)
```

## Restart requirements (critical)

- **Backend `.py` changes → must fully quit and restart Electron.** Python child process is spawned, not hot-reloaded.
- **Frontend `.tsx/.ts` changes → Vite HMR, just refresh `http://localhost:5173/`.**
- Verifying in browser: use `http://localhost:5173/` (IPv6 `::1`). `http://127.0.0.1:5173/` does not reach the Vite dev server.

## Environment gotchas

- If Electron crashes with `require('electron')` returning a string/undefined: `ELECTRON_RUN_AS_NODE` env var is set — unset it.
- Backend `config.py` monkey-patches `subprocess.Popen` on Windows to inject `CREATE_NO_WINDOW` + `BELOW_NORMAL_PRIORITY_CLASS`. Any new subprocess call inherits this — do not bypass.
- Missing runtime deps from `backend/requirements.txt`: `python-multipart` (upload endpoint) and `httpx` (AI service) must be installed manually alongside requirements.
- FFmpeg resolution order: `FFMPEG_PATH` env var → `resources/ffmpeg/ffmpeg.exe` → `node_modules/ffmpeg-static` → system PATH.
- `ffprobe.exe` in the bundled FFmpeg is actually a hardlink to ffmpeg itself, NOT a standalone ffprobe. `video_service.py` works around this by using ffmpeg directly for duration probing.

## Critical conventions (things that caused hard bugs)

1. **Never block the event loop.** Any subprocess call (`ffmpeg`, `ffprobe`) inside an `async def` route must go through `await asyncio.to_thread(...)`. A single synchronous subprocess call stalls the entire uvicorn event loop — `/analyze`, `/status`, `/stop` all deadlock until 30s IPC timeout. This was the root cause of three separate bugs.

2. **Batch vs single-workflow isolation (user red line).** Shared functions (`detect_scenes`, `_analyze_single_video`) take keyword-only defaults for batch optimizations (`skip_nonkeyframes=False`, `lowres=0`). Single-workflow callers always use defaults. Batch flags are ONLY injected from `concurrent_analyzer._default_analyze`. `analysis_cache` is batch-only; single-workflow only reads `scene_cache`. Never break this separation.

3. **FFmpeg `metadata=print:file=-` outputs to stdout, not stderr.** When parsing scene timestamps, scan BOTH `stdout + stderr`. Scanning only stderr silently fails — every video collapses to 1 scene with no error. This bug existed for months undetected.

4. **`-skip_frame nokey` and `-lowres` are input options, must go BEFORE `-i` in ffmpeg commands.** Placing them after `-i` is silently ignored.

5. **HEVC codec does not support `-lowres`.** Only apply `-lowres` when `codec_name == "h264"`. Detect codec via ffprobe before building the filter command.

6. **FFmpeg `drawtext`/`subtitles` text must be escaped** via `_escape_drawtext()` in `services/renderer.py`. Unescaped `:`, `%`, `{`, `}`, `'`, `\` break the filter graph.

7. **File-serving endpoints must validate paths** with `_is_safe_path()` (realpath resolution + media extension allowlist + must resolve under `TEMP_DIR` or a registered material path). Never trust client-supplied paths directly.

8. **`api.post()` from `backend-client.ts` serializes `FormData` as JSON → `{}`.** File uploads (BGM import/delete) must use raw `fetch` + `FormData`, not the `api` wrapper.

9. **React `useCallback` dependency closures:** `AiScriptEditor.handleRun` and `ExportConfirm.handleExport` have large dependency arrays (10+ subtitle/cover style variables). Missing deps = stale closure bugs. When adding subtitle/cover style fields, update these useCallback deps.

## Store persistence is intentional, not missing

- `materials-store`, `editing-store`: **persisted** (localStorage, via zustand `persist` middleware) — losing materials or timeline on refresh is bad UX.
- `analysis-store`, `render-store`: **NOT persisted** — they hold in-flight polling state tied to a live backend. Persisting would resurrect stale "processing" jobs after reload.
- Do not add `persist()` to stores tracking live backend jobs without understanding this split.

## No test framework exists

There is no jest/vitest/pytest config. Backend validation uses ad-hoc scripts:
```bash
python services/concurrent_analyzer.py    # unit self-test (EXIT=0 = green)
python routes/batch.py                     # route self-test with TestClient
python -m py_compile <file>                # syntax check
```
Frontend: `node_modules/.bin/tsc --noEmit -p tsconfig.json` (EXIT=0).

## State management: all step components stay mounted

App.tsx uses a 4-step wizard (素材导入 → AI创作 → 预览调整 → 导出渲染). All step components are always mounted; visibility toggled via CSS `display:none/block`. Step navigation does not destroy component state. Navigation is gated: blocked while any long-running op is active, blocked into step 1 without materials, blocked into step 3 without a generated timeline.

## Git push constraints (this sandbox)

`git push` from this sandbox is blocked by firewall — `github.com` git protocol times out. Push requires GitHub REST Git Data API (blobs → tree → commit → PATCH ref). PAT is extracted from `git remote get-url origin`. Use `git -c core.quotePath=false` for Chinese filenames (default octal escape breaks `open()`).

## Key doc references

- `short-video-mashup-tool/HANDOFF.md` — latest handoff, task status, gotchas
- `short-video-mashup-tool/批量分析_最优迭代方案.md` — batch analysis architecture, F1–F10 fixes, isolation rules
- `short-video-mashup-tool/批量分析控制_概述.md` — play/pause/stop control design
- `short-video-mashup-tool/docs/` — design docs, PRDs, audit reports
- `short-video-mashup-tool/backend/tests/` — ad-hoc test scripts (no framework)
- `.workbuddy/memory/` — development session logs (not project source)
