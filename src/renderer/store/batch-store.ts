/**
 * 批量模式状态层（zustand）—— 与 editing-store 完全解耦。
 *
 * 职责：
 * - 当前批次完整对象镜像（GET /api/batch/{id} 同款结构）
 * - 分析 / 预修 / TTS / 导出 四类后台任务的进度快照 + 1s 轮询（结束自动停）
 * - 全部批量 API 动作封装（组件不直接拼端点）
 *
 * API Key 来源：默认复用 editing-store 的持久化 key（分析/TTS），
 * 但支持批量独立覆盖（analysisKeyUseGlobal / ttsKeyUseGlobal + override 字段）；
 * 覆盖仅存于前端批量 store，不写 editing-store，两个流程互不影响。
 */
import { create } from 'zustand';
import api, { apiRequest } from '@/renderer/api/backend-client';
import { useEditingStore } from './editing-store';
import type {
  AddMaterialsResult,
  AllocationReport,
  Batch,
  BatchClip,
  BatchMaterial,
  BatchScript,
  BatchSummary,
  ClipSegment,
  EstimateResult,
  ExportQueueStatus,
  SubtitleStyle,
  TaskProgress,
} from '@/renderer/types/batch';

type PollKind = 'analyze' | 'prescan' | 'tts' | 'export';

const POLL_INTERVAL_MS = 1000;

/** 轮询定时器（模块级，不进 store 状态，避免无谓 rerender） */
const pollers: Partial<Record<PollKind, ReturnType<typeof setInterval>>> = {};

function stopPoller(kind: PollKind): void {
  const t = pollers[kind];
  if (t !== undefined) {
    clearInterval(t);
    delete pollers[kind];
  }
}

function stopAllPollers(): void {
  (Object.keys(pollers) as PollKind[]).forEach(stopPoller);
}

const POLL_PATH: Record<PollKind, (batchId: string) => string> = {
  analyze: (id) => `/api/batch/${id}/analyze/status`,
  prescan: (id) => `/api/batch/${id}/prescan/status`,
  tts: (id) => `/api/batch/${id}/tts/status`,
  export: (id) => `/api/batch/${id}/export/status`,
};

const EMPTY_PROGRESS: TaskProgress = {
  running: false, done: 0, total: 0, current: '',
  last_status: '', finished_at: null, error: null, state: 'idle',
};

// ① API Key 解析已内联到 startAnalyze / startTts（见下方），支持批量覆盖全局密钥。

export interface BatchState {
  /** 当前批次完整镜像（null = 未进入批次） */
  batch: Batch | null;
  /** 历史列表摘要 */
  summaries: BatchSummary[];
  /** O2 可行性预估 */
  estimate: EstimateResult | null;
  /** 各后台任务进度快照 */
  analyzeProgress: TaskProgress | null;
  prescanProgress: TaskProgress | null;
  ttsProgress: TaskProgress | null;
  exportStatus: ExportQueueStatus | null;
  /** 长流程进行中（如「开始分配」串联 TTS→allocate） */
  busy: boolean;
  error: string | null;

  /** ① API Key 覆盖：批量可独立配置，默认复用全局 editing-store 密钥 */
  analysisKeyUseGlobal: boolean;
  analysisKeyOverride: string;
  ttsKeyUseGlobal: boolean;
  ttsKeyOverride: { qwen: string; doubao: string };
  setAnalysisKeyUseGlobal: (v: boolean) => void;
  setAnalysisKeyOverride: (v: string) => void;
  setTtsKeyUseGlobal: (v: boolean) => void;
  setTtsKeyOverride: (provider: 'qwen' | 'doubao', v: string) => void;

  /** ② 分析并发数（远程视觉 API，网络等待型；可调，默认 10） */
  analysisConcurrency: number;
  setAnalysisConcurrency: (v: number) => void;

  // ── 批次 CRUD ──
  createBatch: (name: string, settings?: Record<string, unknown>) => Promise<Batch | null>;
  loadBatch: (id: string) => Promise<Batch | null>;
  refreshBatch: () => Promise<void>;
  listBatches: () => Promise<BatchSummary[]>;
  deleteBatches: (ids: string[]) => Promise<boolean>;
  clearBatch: () => void;
  setError: (msg: string | null) => void;

  // ── 素材登记 / 分析 / 预修 ──
  registerMaterials: (paths: string[]) => Promise<AddMaterialsResult | null>;
  /** 开始分析；selectedHashes 不传=全部 pending/failed，传则只分析勾选的 */
  startAnalyze: (selectedHashes?: string[]) => Promise<TaskProgress | null>;
  /** 软暂停：停止派发新任务，进行中跑完 */
  pauseAnalyze: () => Promise<void>;
  /** 继续：从暂停处恢复派发 */
  resumeAnalyze: () => Promise<void>;
  /** 软放弃：进行中跑完，剩余回退 pending（可重跑） */
  stopAnalyze: () => Promise<void>;
  startPrescan: () => Promise<TaskProgress | null>;
  updateMaterialRange: (fileHash: string, usableIn: number, usableOut: number) => Promise<boolean>;

  // ── 脚本 / 设置 / 预估 ──
  saveScripts: (scripts: Array<Pick<BatchScript, 'id' | 'text'> & Partial<BatchScript>>) => Promise<boolean>;
  saveSettings: (patch: Partial<{
    voice: string; speed: number; tts_provider: string;
    subtitle_style: SubtitleStyle; bgm_pool: 'all' | string[];
    target_duration: number; segments_per_clip: number;
  }>) => Promise<boolean>;
  loadEstimate: () => Promise<EstimateResult | null>;

  // ── TTS / 分配 ──
  startTts: (force?: boolean) => Promise<TaskProgress | null>;
  allocate: () => Promise<boolean>;
  loadReport: () => Promise<AllocationReport | null>;

  // ── 成片修改（S6 审改用，本期先接好）──
  updateClip: (clipId: string, patch: {
    status?: string;
    segments?: ClipSegment[];
    trim_overrides?: unknown;
    subtitle_overrides?: unknown;
    bgm_name?: string;
    cover?: Record<string, unknown>;
  }) => Promise<boolean>;
  confirmClip: (clipId: string) => Promise<boolean>;
  /** 解锁已确认/已完成成片（回到待确认） */
  unlockClip: (clipId: string) => Promise<boolean>;
  /** 一键确认全部「待确认」成片 */
  confirmAll: () => Promise<number>;
  /** O3 单条重分配：取该片脚本的最新 TTS 槽长调 reallocate */
  reallocateClip: (clipId: string) => Promise<boolean>;

  // ── 导出 ──
  exportSelected: (clipIds: string[] | 'confirmed') => Promise<boolean>;
  pollExportOnce: () => Promise<ExportQueueStatus | null>;
  pauseExport: (paused: boolean) => Promise<void>;
  cancelExport: (clipId: string) => Promise<void>;
  retryExport: (clipId: string) => Promise<void>;
  /** 在系统文件管理器打开输出目录；返回错误消息（null = 成功） */
  openOutputDir: () => Promise<string | null>;
}

export const useBatchStore = create<BatchState>()((set, get) => {
  /** 设置某类任务的进度快照 */
  const setProgress = (kind: PollKind, p: TaskProgress | ExportQueueStatus | null): void => {
    if (kind === 'export') set({ exportStatus: p as ExportQueueStatus | null });
    else if (kind === 'analyze') set({ analyzeProgress: p as TaskProgress | null });
    else if (kind === 'prescan') set({ prescanProgress: p as TaskProgress | null });
    else set({ ttsProgress: p as TaskProgress | null });
  };

  const getProgress = (kind: PollKind): TaskProgress | ExportQueueStatus | null => {
    const s = get();
    if (kind === 'export') return s.exportStatus;
    if (kind === 'analyze') return s.analyzeProgress;
    if (kind === 'prescan') return s.prescanProgress;
    return s.ttsProgress;
  };

  const isFinished = (kind: PollKind, snap: TaskProgress | ExportQueueStatus): boolean => {
    if (kind === 'export') {
      const e = snap as ExportQueueStatus;
      return e.total > 0 ? e.all_done : false;
    }
    return !(snap as TaskProgress).running;
  };

  /**
   * 拉一次某类任务的状态快照并写入 store；返回快照（null = 请求失败）。
   */
  const fetchSnapshot = async (kind: PollKind): Promise<TaskProgress | ExportQueueStatus | null> => {
    const id = get().batch?.id;
    if (!id) return null;
    const r = await api.get<TaskProgress & ExportQueueStatus>(POLL_PATH[kind](id));
    if (r.code !== 0 || !r.data) return null;
    setProgress(kind, r.data);
    return r.data;
  };

  /**
   * 启动 1s 轮询；返回的 Promise 在任务结束（running=false / all_done）时
   * 以最终快照 resolve。结束后自动刷新批次详情（状态/时长/阶段回填）。
   */
  const startPolling = (kind: PollKind): Promise<TaskProgress | ExportQueueStatus | null> => {
    stopPoller(kind);
    return new Promise((resolve) => {
      const tick = async (): Promise<void> => {
        const snap = await fetchSnapshot(kind);
        if (snap === null) return; // 单次失败不杀轮询（网络抖动容忍）
        if (isFinished(kind, snap)) {
          stopPoller(kind);
          await get().refreshBatch();
          resolve(snap);
        }
      };
      pollers[kind] = setInterval(() => { void tick(); }, POLL_INTERVAL_MS);
      void tick();
    });
  };

  /** 若某类任务仍在后端运行（断点恢复场景），恢复其轮询 */
  const resumePollingIfRunning = async (): Promise<void> => {
    const kinds: PollKind[] = ['analyze', 'prescan', 'tts', 'export'];
    for (const kind of kinds) {
      const snap = await fetchSnapshot(kind);
      if (!snap) continue;
      if (kind === 'export') {
        const e = snap as ExportQueueStatus;
        if (e.total > 0 && !e.all_done && pollers[kind] === undefined) void startPolling(kind);
      } else if ((snap as TaskProgress).running && pollers[kind] === undefined) {
        void startPolling(kind);
      }
    }
  };

  return {
    batch: null,
    summaries: [],
    estimate: null,
    analyzeProgress: null,
    prescanProgress: null,
    ttsProgress: null,
    exportStatus: null,
    busy: false,
    error: null,

    // ① API Key 覆盖默认值（复用全局）
    analysisKeyUseGlobal: true,
    analysisKeyOverride: '',
    ttsKeyUseGlobal: true,
    ttsKeyOverride: { qwen: '', doubao: '' },
    /** ② 分析并发数（默认 10） */
    analysisConcurrency: 10,

    setError: (msg) => set({ error: msg }),

    // ── ① API Key 覆盖（批量独立配置，默认复用全局） ──
    setAnalysisKeyUseGlobal: (v) => set((s) => ({
      analysisKeyUseGlobal: v,
      analysisKeyOverride: v ? '' : (useEditingStore.getState().analysisApiKey || s.analysisKeyOverride),
    })),
    setAnalysisKeyOverride: (v) => set({ analysisKeyOverride: v }),
    setAnalysisConcurrency: (v) => set({ analysisConcurrency: v }),
    setTtsKeyUseGlobal: (v) => set((s) => {
      const ed = useEditingStore.getState();
      if (v) return { ttsKeyUseGlobal: true };
      const provider = ed.ttsProvider;
      return { ttsKeyUseGlobal: false, ttsKeyOverride: { ...s.ttsKeyOverride, [provider]: ed.ttsApiKeys[provider] || '' } };
    }),
    setTtsKeyOverride: (provider, v) => set((s) => ({ ttsKeyOverride: { ...s.ttsKeyOverride, [provider]: v } })),

    // ── 批次 CRUD ──────────────────────────────────────────

    createBatch: async (name, settings) => {
      const r = await api.post<Batch>('/api/batch/create', { name, settings });
      if (r.code !== 0 || !r.data) {
        set({ error: r.message || '创建批次失败' });
        return null;
      }
      set({
        batch: r.data, estimate: null, error: null,
        analyzeProgress: null, prescanProgress: null, ttsProgress: null, exportStatus: null,
        analysisKeyUseGlobal: true, analysisKeyOverride: '',
        ttsKeyUseGlobal: true, ttsKeyOverride: { qwen: '', doubao: '' },
      });
      return r.data;
    },

    loadBatch: async (id) => {
      const r = await api.get<Batch>(`/api/batch/${id}`);
      if (r.code !== 0 || !r.data) {
        set({ error: r.message || '批次加载失败' });
        return null;
      }
      set({
        batch: r.data, error: null,
        analysisKeyUseGlobal: true, analysisKeyOverride: '',
        ttsKeyUseGlobal: true, ttsKeyOverride: { qwen: '', doubao: '' },
      });
      await resumePollingIfRunning();
      return r.data;
    },

    refreshBatch: async () => {
      const id = get().batch?.id;
      if (!id) return;
      const r = await api.get<Batch>(`/api/batch/${id}`);
      if (r.code === 0 && r.data) set({ batch: r.data });
    },

    listBatches: async () => {
      const r = await api.get<BatchSummary[]>('/api/batch/list');
      if (r.code === 0 && Array.isArray(r.data)) {
        set({ summaries: r.data });
        return r.data;
      }
      return get().summaries;
    },

    deleteBatches: async (ids) => {
      const r = await apiRequest<{ deleted: string[]; not_found: string[] }>(
        '/api/batch/delete', { method: 'DELETE', body: { ids } },
      );
      if (r.code !== 0) {
        set({ error: r.message || '删除批次失败' });
        return false;
      }
      const cur = get().batch;
      if (cur && ids.includes(cur.id)) get().clearBatch();
      await get().listBatches();
      return true;
    },

    clearBatch: () => {
      stopAllPollers();
      set({
        batch: null, estimate: null, error: null, busy: false,
        analyzeProgress: null, prescanProgress: null, ttsProgress: null, exportStatus: null,
        analysisKeyUseGlobal: true, analysisKeyOverride: '',
        ttsKeyUseGlobal: true, ttsKeyOverride: { qwen: '', doubao: '' },
      });
    },

    // ── 素材登记 / 分析 / 预修 ─────────────────────────────

    registerMaterials: async (paths) => {
      const b = get().batch;
      if (!b || paths.length === 0) return null;
      const r = await api.post<AddMaterialsResult>(`/api/batch/${b.id}/materials/add`, { paths });
      if (r.code !== 0 || !r.data) {
        set({ error: r.message || '素材登记失败' });
        return null;
      }
      // 本地合并（added 已含完整素材条目），哈希去重保险
      const known = new Set(b.materials.map((m) => m.file_hash));
      const merged = [...b.materials, ...r.data.added.filter((m) => !known.has(m.file_hash))];
      set({ batch: { ...b, materials: merged } });
      return r.data;
    },

    startAnalyze: async (selectedHashes?: string[]) => {
      const b = get().batch;
      if (!b) return null;
      const ed = useEditingStore.getState();
      const st = get();
      const apiKey = st.analysisKeyUseGlobal ? (ed.analysisApiKey || '') : (st.analysisKeyOverride || '');
      const model = ed.analysisModel || '';
      if (!apiKey) {
        set({ error: '未配置「画面分析」API Key，无法开始分析' });
        return null;
      }
      const body: Record<string, unknown> = {
        api_key: apiKey, model, max_workers: st.analysisConcurrency,
      };
      // 勾选过滤：只分析勾选的素材（前端「开始分析」透传勾选集合）
      if (selectedHashes && selectedHashes.length > 0) body.file_hashes = selectedHashes;
      const r = await api.post<{ total: number }>(`/api/batch/${b.id}/analyze`, body);
      if (r.code !== 0) {
        set({ error: r.message || '分析启动失败' });
        return null;
      }
      set({ error: null });
      if (!r.data || r.data.total === 0) {
        await get().refreshBatch();
        return { ...EMPTY_PROGRESS };
      }
      return (await startPolling('analyze')) as TaskProgress | null;
    },

    pauseAnalyze: async () => {
      const b = get().batch;
      if (!b) return;
      const r = await api.post(`/api/batch/${b.id}/analyze/pause`, {});
      if (r.code !== 0) { set({ error: r.message || '暂停失败' }); return; }
      set({ error: null });
      // 确保轮询在跑（暂停时 running 仍为 true，快照 state=paused）
      void startPolling('analyze');
    },

    resumeAnalyze: async () => {
      const b = get().batch;
      if (!b) return;
      const r = await api.post(`/api/batch/${b.id}/analyze/resume`, {});
      if (r.code !== 0) { set({ error: r.message || '继续失败' }); return; }
      set({ error: null });
      void startPolling('analyze');
    },

    stopAnalyze: async () => {
      const b = get().batch;
      if (!b) return;
      const r = await api.post(`/api/batch/${b.id}/analyze/stop`, {});
      if (r.code !== 0) { set({ error: r.message || '停止失败' }); return; }
      set({ error: null });
      // 停止后后端先置 stopping 再回 idle，轮询持续直到 running=false
      void startPolling('analyze');
    },

    startPrescan: async () => {
      const b = get().batch;
      if (!b) return null;
      const r = await api.post<{ total: number }>(`/api/batch/${b.id}/prescan`, {});
      if (r.code !== 0) {
        set({ error: r.message || '预修启动失败' });
        return null;
      }
      set({ error: null });
      if (!r.data || r.data.total === 0) {
        await get().refreshBatch();
        return { ...EMPTY_PROGRESS };
      }
      return (await startPolling('prescan')) as TaskProgress | null;
    },

    updateMaterialRange: async (fileHash, usableIn, usableOut) => {
      const b = get().batch;
      if (!b) return false;
      const r = await api.post<BatchMaterial>(`/api/batch/${b.id}/materials/update`, {
        file_hash: fileHash, usable_in: usableIn, usable_out: usableOut,
      });
      if (r.code !== 0 || !r.data) {
        set({ error: r.message || '预修结果写回失败' });
        return false;
      }
      const updated = r.data;
      set({
        batch: {
          ...b,
          materials: b.materials.map((m) => (m.file_hash === fileHash ? { ...m, ...updated } : m)),
        },
      });
      return true;
    },

    // ── 脚本 / 设置 / 预估 ─────────────────────────────────

    saveScripts: async (scripts) => {
      const b = get().batch;
      if (!b) return false;
      const r = await api.post<{ count: number }>(`/api/batch/${b.id}/scripts`, { scripts });
      if (r.code !== 0) {
        set({ error: r.message || '脚本保存失败' });
        return false;
      }
      await get().refreshBatch();
      return true;
    },

    saveSettings: async (patch) => {
      const b = get().batch;
      if (!b) return false;
      const r = await api.post<Batch['global_settings']>(`/api/batch/${b.id}/settings`, patch);
      if (r.code !== 0 || !r.data) {
        set({ error: r.message || '设置保存失败' });
        return false;
      }
      set({ batch: { ...get().batch!, global_settings: r.data } });
      return true;
    },

    loadEstimate: async () => {
      const b = get().batch;
      if (!b) return null;
      const r = await api.get<EstimateResult>(`/api/batch/${b.id}/estimate`);
      if (r.code === 0 && r.data) {
        set({ estimate: r.data });
        return r.data;
      }
      return null;
    },

    // ── TTS / 分配 ─────────────────────────────────────────

    startTts: async (force = false) => {
      const b = get().batch;
      if (!b) return null;
      const ed = useEditingStore.getState();
      const st = get();
      const provider = ed.ttsProvider;
      const apiKey = st.ttsKeyUseGlobal ? (ed.ttsApiKeys[provider] || '') : (st.ttsKeyOverride[provider] || '');
      if (!apiKey) {
        set({ error: '未配置「语音合成」API Key，无法生成 TTS' });
        return null;
      }
      const model = ed.analysisModel || '';
      const r = await api.post<{ total: number }>(`/api/batch/${b.id}/tts`, {
        api_key: apiKey, model, force,
      });
      if (r.code !== 0) {
        set({ error: r.message || 'TTS 启动失败' });
        return null;
      }
      set({ error: null });
      if (!r.data || r.data.total === 0) {
        await get().refreshBatch();
        return { ...EMPTY_PROGRESS };
      }
      return (await startPolling('tts')) as TaskProgress | null;
    },

    allocate: async () => {
      const b = get().batch;
      if (!b) return false;
      const r = await api.post<Record<string, unknown>>(`/api/batch/${b.id}/allocate`, {});
      if (r.code !== 0) {
        set({ error: r.message || '分配失败' });
        return false;
      }
      set({ error: null });
      await get().refreshBatch();
      return true;
    },

    loadReport: async () => {
      const b = get().batch;
      if (!b) return null;
      const r = await api.get<AllocationReport>(`/api/batch/${b.id}/allocation-report`);
      if (r.code !== 0 || !r.data) return null;
      const cur = get().batch;
      if (cur) set({ batch: { ...cur, allocation_report: r.data } });
      return r.data;
    },

    // ── 成片修改 ───────────────────────────────────────────

    updateClip: async (clipId, patch) => {
      const b = get().batch;
      if (!b) return false;
      // BGM / 封面走专用端点（后端有撞曲检查与 user_modified 标记）
      if (patch.bgm_name !== undefined) {
        const r = await api.post(`/api/batch/${b.id}/clips/${clipId}/bgm`, { bgm_name: patch.bgm_name });
        if (r.code !== 0) { set({ error: r.message || 'BGM 更换失败' }); return false; }
      }
      if (patch.cover !== undefined) {
        const r = await api.post(`/api/batch/${b.id}/clips/${clipId}/cover`, patch.cover);
        if (r.code !== 0) { set({ error: r.message || '封面修改失败' }); return false; }
      }
      const rest: Record<string, unknown> = {};
      if (patch.status !== undefined) rest.status = patch.status;
      if (patch.segments !== undefined) rest.segments = patch.segments;
      if (patch.trim_overrides !== undefined) rest.trim_overrides = patch.trim_overrides;
      if (patch.subtitle_overrides !== undefined) rest.subtitle_overrides = patch.subtitle_overrides;
      if (Object.keys(rest).length > 0) {
        const r = await api.post<BatchClip>(`/api/batch/${b.id}/clips/${clipId}/update`, rest);
        if (r.code !== 0) { set({ error: r.message || '成片更新失败' }); return false; }
      }
      await get().refreshBatch();
      return true;
    },

    confirmClip: async (clipId) => get().updateClip(clipId, { status: '已确认' }),

    unlockClip: async (clipId) => get().updateClip(clipId, { status: '待确认' }),

    confirmAll: async () => {
      const b = get().batch;
      if (!b) return 0;
      const targets = b.clips.filter((c) => c.status === '待确认');
      let n = 0;
      for (const c of targets) {
        if (await get().updateClip(c.id, { status: '已确认' })) n += 1;
      }
      await get().refreshBatch();
      return n;
    },

    reallocateClip: async (clipId) => {
      const b = get().batch;
      if (!b) return false;
      const clip = b.clips.find((c) => c.id === clipId);
      if (!clip) { set({ error: '成片不存在' }); return false; }
      const script = b.scripts.find((s) => s.id === clip.script_id);
      const tts = script?.tts;
      if (!tts || tts.status !== 'done' || !tts.seg_durations) {
        set({ error: '该片脚本尚未完成 TTS，无法重跑分配' });
        return false;
      }
      const texts = (tts.segments ?? []).map((s) => s.text ?? '');
      const r = await api.post(`/api/batch/${b.id}/clips/${clipId}/reallocate`, {
        seg_durations: tts.seg_durations,
        segment_texts: texts,
      });
      if (r.code !== 0) {
        set({ error: r.message || '重跑分配失败' });
        return false;
      }
      set({ error: null });
      await get().refreshBatch();
      return true;
    },

    // ── 导出 ───────────────────────────────────────────────

    exportSelected: async (clipIds) => {
      const b = get().batch;
      if (!b) return false;
      const r = await api.post(`/api/batch/${b.id}/export`, { clip_ids: clipIds });
      if (r.code !== 0) {
        set({ error: r.message || '导出启动失败' });
        return false;
      }
      set({ error: null });
      void startPolling('export');
      return true;
    },

    pollExportOnce: async () => (await fetchSnapshot('export')) as ExportQueueStatus | null,

    pauseExport: async (paused) => {
      const b = get().batch;
      if (!b) return;
      await api.post(`/api/batch/${b.id}/export/pause`, { paused });
      await get().pollExportOnce();
    },

    cancelExport: async (clipId) => {
      const b = get().batch;
      if (!b) return;
      await api.post(`/api/batch/${b.id}/export/cancel/${clipId}`, {});
      await get().pollExportOnce();
      await get().refreshBatch();
    },

    retryExport: async (clipId) => {
      const b = get().batch;
      if (!b) return;
      await api.post(`/api/batch/${b.id}/export/retry/${clipId}`, {});
      void startPolling('export');
    },

    openOutputDir: async () => {
      const b = get().batch;
      if (!b) return '未选择批次';
      const r = await api.post<{ dir: string }>(`/api/batch/${b.id}/export/open-output`, {});
      if (r.code !== 0) return r.message || '打开输出目录失败';
      return null;
    },
  };
});

/** 停止全部轮询（退出批量向导时调用；后端任务继续，重回批次时 loadBatch 自动恢复轮询） */
export function stopAllBatchPolling(): void {
  stopAllPollers();
}

export default useBatchStore;
