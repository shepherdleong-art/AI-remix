# 短视频智能混剪工具 —— 改进计划 (Improvement Plan)

> 本文档面向后续接手的 AI / 开发者，记录当前代码库经审计后发现的主要问题、根因、影响面与建议修复方向。
> 所有问题均已对照实际代码定位到文件与行号（行号为审计时快照，改动后可能漂移，请以符号名为准复核）。
>
> 项目架构速览：Electron（主进程 Node/TS + React 渲染层） + Python FastAPI 后端（FFmpeg/OpenCV/LLM）。
> 前后端通过本地 HTTP（端口 18000-18999 自动选择）+ 轮询通信。

---

## 优先级总览

| 序号 | 主题 | 影响 | 优先级 | 建议改动量 |
|------|------|------|--------|-----------|
| P0-1 | 同步阻塞调用卡死 asyncio 事件循环 | 单请求拖垮全部 API | **最高** | 小 |
| P0-2 | Python 进程崩溃后 Electron 不重启 | 后端崩 = App 不可用 | **最高** | 中 |
| P1-1 | 分析任务无界线程，打爆 CPU | 多任务并发时机器卡死 | 高 | 中 |
| P1-2 | LLM 批量帧分析串行，延迟 N 倍 | 体验慢 | 高 | 小 |
| P1-3 | 错误被吞、子进程返回码不检查 | 静默失败、难排查 | 高 | 中 |
| P2-1 | 前端零持久化，刷新即丢工作 | 数据丢失 | 中 | 中 |
| P2-2 | 步骤导航无校验 + 状态互斥缺失 | 状态不一致 | 中 | 中 |
| P2-3 | 轮询定时器不清理，内存泄漏 | 长期运行劣化 | 中 | 小 |
| P3-1 | 渲染并发配置形同虚设 | 未用满硬件 | 低 | 小 |
| P3-2 | 路径穿越 / FFmpeg 文本转义不全 | 安全 / 健壮性 | 低 | 小 |

---

## P0-1 ｜ 同步阻塞调用卡死 asyncio 事件循环

**问题**
`backend/routes/ai_editing.py` 的 `full_pipeline`（约 `:186-298`）是 `async def`，但内部直接调用了同步 CPU 密集 / FFmpeg 阻塞函数：
- `detect_scenes(vp)`（约 `:229`）
- `extract_scene_frames(vp, scenes, frame_dir)`（约 `:231`）

**根因**
FastAPI 单 worker、默认 asyncio 事件循环。在 `async` 路由里直接跑同步阻塞代码，会霸占事件循环线程，导致**该请求执行期间所有其他 API（包括前端的进度轮询）全部卡住**。

**影响面**
最大。一个 pipeline 请求就能让整个后端"假死"。

**修复方向**
- 将所有同步阻塞调用用 `await asyncio.to_thread(...)` 移出事件循环；或统一交给线程池执行器。
- 全局排查其它 `async def` 路由中是否还混有同步 `subprocess.run` / OpenCV / 文件大 IO 调用。

**验收**
- pipeline 运行期间，并发调用 `/api/health` 与状态轮询接口响应时延无明显抖动。

---

## P0-2 ｜ Python 进程崩溃后 Electron 不重启

**问题**
`src/main/python-bridge.ts`：
- 进程 `error`（约 `:97`）/ `exit`（约 `:102`）回调仅设置 `isRunning = false`，无任何重启逻辑。
- 心跳健康检查（约 `:245`）失败时只 `console.warn`，不触发重连或重启。
- 端口解析依赖 stdout 的 `PORT:(\d{4,5})`（约 `:80-88`）；若 Python 启动即崩，`this.port` 永远为 `null`，无错误抛出。

**影响面**
后端一旦崩溃，前端所有请求挂死，用户只能重启 App。

**修复方向**
- 增加带指数退避（如 1s/2s/4s，封顶 N 次）的自动重启逻辑。
- 心跳连续失败达阈值时主动重启后端进程。
- 重启 / 断连状态通过 IPC 通知渲染层，前端展示"后端重连中"提示并暂停轮询。
- 启动失败（端口未解析、健康检查超时）应抛出可识别错误并向用户提示，而非静默继续（当前 `src/main/index.ts:64` 仅 log）。

**验收**
- 手动 kill Python 进程后，后端在数秒内自动恢复，前端给出提示且功能恢复。

---

## P1-1 ｜ 分析任务无界线程，打爆 CPU

**问题**
`backend/routes/analysis.py`（约 `:297-302`）每个分析请求都 `threading.Thread()` 起新线程，无线程池、无上限。`analyzer.py` 内的帧提取 / 直方图 / OpenCV 全是同步 CPU 密集型。`config.py` 定义了 `MAX_CONCURRENT_ANALYSIS` 但**代码从未引用**。

**影响面**
N 个素材并发分析 = N 条线程抢 CPU，机器可能直接卡死。

**修复方向**
- 引入有界 `ThreadPoolExecutor`（worker 数取自 `MAX_CONCURRENT_ANALYSIS`），或统一改为带信号量的任务队列。
- 超出并发上限的请求进入排队，而非立即起线程。
- 复用渲染模块已有的"队列 + worker"模式以保持一致性（见 `renderer.py` 的 `RenderQueue`）。

**验收**
- 同时提交远超 CPU 核数的分析任务，活跃线程数受限于配置值，系统不卡死。

---

## P1-2 ｜ LLM 批量帧分析串行，延迟 N 倍

**问题**
`backend/services/ai_service.py` 的 `analyze_frames_batch`（约 `:180-203`）用 `for` 循环逐帧 `await analyze_frame(...)`，虽是 async 但完全无并行。

**根因**
这是网络 IO 等待场景，串行白白浪费并发能力。

**修复方向**
- 改用 `asyncio.gather` 并发发起请求，配合 `asyncio.Semaphore` 限制并发数（避免触发 LLM 服务端限流）。
- 保留结果顺序（gather 默认按输入顺序返回）。

**验收**
- 多帧分析总耗时显著下降（接近单帧耗时 × ceil(N / 并发数)），且不触发服务端 429。

---

## P1-3 ｜ 错误被吞、子进程返回码不检查

**问题**
1. **路由层吞错**：`backend/routes/ai_editing.py` 多个端点（约 `:63, :102, :134, :182, :297`）清一色 `except Exception as e: return str(e)`，丢失错误类型与上下文。前端收到 `请求异常: TypeError: Failed to fetch` 之类无法处理的字符串。
2. **FFmpeg 子进程不检查 returncode**：
   - `ai_editing.py:404-424`（预览裁剪 / 拼接）仅靠 `os.path.exists(out)` 判断成败。
   - `video_service.py:50`（时长探测）、`:70`（场景检测）不检查返回码。
   - FFmpeg 静默失败产出半成品 / 损坏文件仍会继续往下走。
3. **LLM 响应解析脆弱**：`ai_service.py:250-260, :317-325` 假设响应一定包了 ```` ```json ````；`data["choices"][0]["message"]["content"]`（约 `:176, :251, :318`）不校验结构；无 HTTP 429（限流）处理；无重试 / 退避。

**修复方向**
- 路由层区分错误类型，返回结构化错误（错误码 + 用户可读消息 + 可选 detail），避免直接 `str(e)`。
- 所有 FFmpeg / ffprobe 调用检查 `returncode != 0`，失败时记录 stderr 并抛出明确异常。
- LLM 调用：增加重试（指数退避）、429 处理、响应结构校验；JSON 解析失败时给出可恢复提示而非裸 `JSONDecodeError`。

**验收**
- 注入一个会失败的 FFmpeg 命令 / 畸形 LLM 响应，系统给出明确错误而非静默产出坏结果。

---

## P2-1 ｜ 前端零持久化，刷新即丢失工作

**问题**
`src/renderer/store/` 下 5 个 Zustand store 全为内存态，仅渲染预设存了 localStorage（`render-store.ts:178`）。任意时刻刷新 / 崩溃 = 已导入素材、AI 脚本、时间线全部丢失。

**修复方向**
- 对关键 store（materials / editing / analysis 结果）接入 Zustand `persist` 中间件 + 适当存储（localStorage 或 IndexedDB）。
- 设计恢复策略：重启后可从持久化状态恢复到上次步骤。
- 渲染 / 分析任务状态也应可持久化，避免崩溃后无法续接。

---

## P2-2 ｜ 步骤导航无校验 + 状态互斥缺失

**问题**
- `src/renderer/App.tsx`（约 `:90`）StepButton 允许跳到任意步骤，无前置校验（可在无素材时直接进第 4 步）。
- 渲染进行中仍可回到第 3 步编辑时间线；`editing-store` 与 `render-store` 之间无互锁，导致输出与显示不一致。
- `editing-store` 的 `running` 标志（约 `:44, :61, :102`）仅用于禁用 UI，不阻止并发 API 调用。

**修复方向**
- 步骤切换增加前置条件校验（如必须有素材 / 时间线才能进入对应步骤）。
- 长任务（分析 / 渲染）执行期间锁定相关编辑入口与步骤导航。
- 引入跨 store 的全局"忙碌"状态协调，防止竞态写入。

---

## P2-3 ｜ 轮询定时器不清理，内存泄漏

**问题**
- `analysis-store.ts`（约 `:191`）的轮询 `setInterval` 在组件卸载时不会自动清理，需手动调 `stopPolling()`，但组件未做卸载清理。
- `render-store.ts` 的 `_stopPolling()`（约 `:516-524`）清 timer 后本地 `_pollTimers` 清理不彻底，存在悬挂引用。
- 轮询出错时静默重试（`render-store.ts:593-597`），任务可能"卡住"而用户无感知。

**修复方向**
- 组件 `useEffect` 卸载时统一停止对应轮询。
- store 内维护的 timer 句柄在停止时彻底清除。
- 轮询连续失败达阈值应上报为可见错误，而非无限静默重试。

---

## P3-1 ｜ 渲染并发配置形同虚设

**问题**
`renderer.py` 的 `RenderQueue` 用单 worker 串行（设计本身合理），但 `config.py`（约 `:183`）定义的 `PARALLEL_RENDER_WORKERS = max(1, cpu_count - 1)` **从未被读取**，实际永远是 1 个 worker。

**修复方向**
- 若需并行渲染，按 `PARALLEL_RENDER_WORKERS` 启动多个 worker；否则删除该死配置避免误导。
- 注意：并行渲染会成倍占用 CPU / 内存，需结合机器资源评估，建议设上限。

---

## P3-2 ｜ 路径穿越 / FFmpeg 文本转义不全

**问题**
- `ai_editing.py` 的 `_is_safe_path()` / `register_material_path()`（约 `:492-532`）用 `os.path.realpath()` 解析符号链接，但未校验解析后路径是否仍在安全目录内，存在符号链接绕过风险。
- 文件操作前不校验大小（`ai_editing.py:72`、`materials.py:176`），超大 / 损坏文件可能耗尽内存或使 ffprobe 挂起。
- 文本叠加转义不全：`renderer.py`（约 `:294`）`drawtext` 仅替换单引号，未处理 FFmpeg 滤镜语法中的 `:` 等特殊字符，含特殊字符的字幕会破坏滤镜。

**修复方向**
- `_is_safe_path` 校验 realpath 解析结果仍位于允许的根目录下。
- 操作前增加文件大小 / 格式校验。
- 使用完整的 FFmpeg drawtext 转义（处理 `:`、`\`、`'`、`%` 等）。

---

## 建议执行顺序

1. **先打地基（P0）**：P0-1（移出阻塞调用，改动小、收益最大） → P0-2（进程自愈）。
2. **再提性能与健壮性（P1）**：P1-2（LLM 并发，改动小）→ P1-1（分析队列）→ P1-3（错误处理）。
3. **最后补体验与安全（P2 / P3）**：持久化、状态互斥、定时器清理、并发配置、安全加固。

> 每完成一项请：补充 / 运行相关测试 → 跑通构建（前端 `npm run build`、后端可启动并通过 `/api/health`）→ 记录验收结果。
> 当前仓库无测试框架，新增功能 / 修 bug 时建议补齐对应单测。
